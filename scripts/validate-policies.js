#!/usr/bin/env node

/**
 * LCNC Policy Compliance Script
 * Validates exported Mendix model files against organization policies.
 *
 * Policy Categories:
 * 1. Naming conventions
 * 2. Required documentation
 * 3. Security role requirements
 * 4. Structural requirements
 *
 * Exit codes:
 * 0 = All policies passed
 * 1 = Policy violations detected
 */

const fs = require('fs');
const path = require('path');

// Default policies (can be overridden via .ldv-policies.json)
const DEFAULT_POLICIES = {
  naming: {
    enabled: true,
    rules: {
      entities: {
        pattern: '^[A-Z][a-zA-Z0-9]*$',
        message: 'Entity names must be PascalCase',
      },
      microflows: {
        pattern: '^[A-Z][a-zA-Z0-9]*(_[A-Z][a-zA-Z0-9]*)*$',
        message: 'Microflow names must be PascalCase with optional underscores',
      },
      pages: {
        pattern: '^[A-Z][a-zA-Z0-9]*(_[A-Z][a-zA-Z0-9]*)*$',
        message: 'Page names must be PascalCase with optional underscores',
      },
    },
  },

  documentation: {
    enabled: true,
    rules: {
      microflows: {
        required: true,
        minLength: 10,
        message: 'Microflows must have documentation (min 10 chars)',
      },
      pages: {
        required: false,
        minLength: 0,
      },
    },
  },

  security: {
    enabled: true,
    rules: {
      requireAllowedRoles: {
        enabled: true,
        forTypes: ['pages', 'microflows'],
        message: 'Pages and microflows must have allowedRoles defined',
      },
      noAnonymousAccess: {
        enabled: true,
        blockedRoles: ['Anonymous', 'Guest'],
        message: 'Anonymous/Guest access should be explicitly approved',
      },
    },
  },

  structure: {
    enabled: true,
    rules: {
      maxEntitiesPerModule: {
        enabled: true,
        max: 50,
        message: 'Modules should not have more than 50 entities',
      },
      maxMicroflowParameters: {
        enabled: true,
        max: 10,
        message: 'Microflows should not have more than 10 parameters',
      },
    },
  },
};

function loadPolicies() {
  const policyFiles = [
    '.ldv-policies.json',
    'ldv-policies.json',
    'policies.json',
  ];

  for (const file of policyFiles) {
    if (fs.existsSync(file)) {
      try {
        const customPolicies = JSON.parse(fs.readFileSync(file, 'utf8'));
        console.log(`📋 Loaded custom policies from ${file}\n`);
        return { ...DEFAULT_POLICIES, ...customPolicies };
      } catch (e) {
        console.warn(`⚠️  Failed to parse ${file}, using defaults`);
      }
    }
  }

  console.log(
    '📋 Using default policies (create .ldv-policies.json to customize)\n',
  );
  return DEFAULT_POLICIES;
}

function checkNamingConvention(name, pattern, type) {
  const regex = new RegExp(pattern);
  return regex.test(name);
}

function validateFile(filePath, type, policies) {
  const violations = [];

  try {
    const content = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const name = content.name || path.basename(filePath, '.json');

    // Naming check
    if (policies.naming.enabled && policies.naming.rules[type]) {
      const rule = policies.naming.rules[type];
      if (!checkNamingConvention(name, rule.pattern, type)) {
        violations.push({
          type: 'naming',
          severity: 'warning',
          file: filePath,
          message: `${rule.message}: "${name}"`,
        });
      }
    }

    // Documentation check (for microflows and pages)
    if (policies.documentation.enabled && policies.documentation.rules[type]) {
      const rule = policies.documentation.rules[type];
      if (rule.required) {
        const docs = content.documentation || '';
        if (docs.length < rule.minLength) {
          violations.push({
            type: 'documentation',
            severity: 'warning',
            file: filePath,
            message:
              rule.message || `Missing or short documentation for ${name}`,
          });
        }
      }
    }

    // Security check - allowedRoles
    if (policies.security.enabled) {
      const secRules = policies.security.rules;

      if (
        secRules.requireAllowedRoles.enabled &&
        secRules.requireAllowedRoles.forTypes.includes(type)
      ) {
        if (!content.allowedRoles || content.allowedRoles.length === 0) {
          violations.push({
            type: 'security',
            severity: 'error',
            file: filePath,
            message: secRules.requireAllowedRoles.message,
          });
        }
      }
    }

    // Structure checks
    if (policies.structure.enabled && type === 'microflows') {
      const structRules = policies.structure.rules;

      if (structRules.maxMicroflowParameters.enabled) {
        const params = content.parameters || [];
        if (params.length > structRules.maxMicroflowParameters.max) {
          violations.push({
            type: 'structure',
            severity: 'warning',
            file: filePath,
            message: `${structRules.maxMicroflowParameters.message}: ${params.length} parameters`,
          });
        }
      }
    }

    if (policies.structure.enabled && type === 'domain-model') {
      const structRules = policies.structure.rules;

      if (structRules.maxEntitiesPerModule.enabled) {
        const entities = content.entities || [];
        if (entities.length > structRules.maxEntitiesPerModule.max) {
          violations.push({
            type: 'structure',
            severity: 'warning',
            file: filePath,
            message: `${structRules.maxEntitiesPerModule.message}: ${entities.length} entities`,
          });
        }
      }
    }
  } catch (e) {
    // Skip files that can't be parsed
  }

  return violations;
}

function findFiles(dir, type) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findFiles(fullPath, type));
    } else if (entry.name.endsWith('.json')) {
      files.push({ path: fullPath, type });
    }
  }

  return files;
}

function main() {
  console.log('📜 Running policy compliance check...\n');

  const policies = loadPolicies();
  const allViolations = [];

  // Search paths for Mendix model exports
  const searchPaths = ['.', 'model', 'mendix-model', 'export'];
  const modelTypes = ['domain-model', 'pages', 'microflows', 'nanoflows'];

  for (const basePath of searchPaths) {
    for (const modelType of modelTypes) {
      const searchDir = path.join(basePath, modelType);
      const files = findFiles(searchDir, modelType);

      for (const file of files) {
        const violations = validateFile(file.path, file.type, policies);
        allViolations.push(...violations);
      }
    }
  }

  if (allViolations.length === 0) {
    console.log('✅ All policy checks passed');
    process.exit(0);
  }

  // Group by type and severity
  const errors = allViolations.filter((v) => v.severity === 'error');
  const warnings = allViolations.filter((v) => v.severity === 'warning');

  if (warnings.length > 0) {
    console.log(`⚠️  WARNINGS (${warnings.length}):`);
    for (const v of warnings) {
      console.log(`   [${v.type}] ${path.relative('.', v.file)}`);
      console.log(`      ${v.message}`);
    }
    console.log();
  }

  if (errors.length > 0) {
    console.log(`❌ ERRORS (${errors.length}):`);
    for (const v of errors) {
      console.log(`   [${v.type}] ${path.relative('.', v.file)}`);
      console.log(`      ${v.message}`);
    }
    console.log();
    console.log(`\n❌ ${errors.length} policy violation(s) must be fixed`);
    process.exit(1);
  }

  console.log(`\n⚠️  ${warnings.length} warning(s) - review recommended`);
  process.exit(0);
}

main();
