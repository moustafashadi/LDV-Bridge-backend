#!/usr/bin/env node

/**
 * LCNC Schema Validation Script
 * Validates exported Mendix model JSON files against expected schema structure.
 *
 * Exit codes:
 * 0 = All validations passed
 * 1 = Validation failed
 */

const fs = require('fs');
const path = require('path');

const MENDIX_EXPORT_DIRS = [
  'domain-model',
  'pages',
  'microflows',
  'nanoflows',
  'constants',
];

// Schema definitions for Mendix model elements
const schemas = {
  'domain-model': {
    required: ['moduleName'],
    optional: ['entities', 'associations'],
  },
  pages: {
    required: ['name'],
    optional: ['documentation', 'layoutCall', 'url', 'allowedRoles'],
  },
  microflows: {
    required: ['name'],
    optional: ['documentation', 'returnType', 'parameters', 'allowedRoles'],
  },
  nanoflows: {
    required: ['name'],
    optional: ['documentation', 'returnType'],
  },
  constants: {
    required: ['name'],
    optional: ['value', 'documentation'],
  },
};

function validateJsonFile(filePath, schemaType) {
  const errors = [];

  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const data = JSON.parse(content);

    const schema = schemas[schemaType];
    if (!schema) {
      return errors; // Unknown type, skip validation
    }

    // Check required fields
    for (const field of schema.required) {
      if (data[field] === undefined) {
        errors.push(`Missing required field '${field}' in ${filePath}`);
      }
    }

    // Check for completely empty objects (suspicious)
    if (Object.keys(data).length === 0) {
      errors.push(`Empty object in ${filePath}`);
    }
  } catch (e) {
    if (e.code === 'ENOENT') {
      // File doesn't exist, skip
    } else if (e instanceof SyntaxError) {
      errors.push(`Invalid JSON in ${filePath}: ${e.message}`);
    } else {
      errors.push(`Error reading ${filePath}: ${e.message}`);
    }
  }

  return errors;
}

function findJsonFiles(dir) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...findJsonFiles(fullPath));
    } else if (entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

function main() {
  console.log('🔍 Running schema validation...\n');

  const errors = [];
  let totalFiles = 0;

  // Find the model export directory (could be in repo root or a subdirectory)
  const searchPaths = ['.', 'model', 'mendix-model', 'export'];

  for (const basePath of searchPaths) {
    for (const dir of MENDIX_EXPORT_DIRS) {
      const searchDir = path.join(basePath, dir);
      const files = findJsonFiles(searchDir);

      for (const file of files) {
        totalFiles++;
        const relPath = path.relative('.', file);
        const fileErrors = validateJsonFile(file, dir);

        if (fileErrors.length > 0) {
          errors.push(...fileErrors);
          console.log(`❌ ${relPath}`);
          fileErrors.forEach((e) => console.log(`   └─ ${e}`));
        } else {
          console.log(`✓ ${relPath}`);
        }
      }
    }
  }

  console.log(`\n📊 Validated ${totalFiles} files`);

  if (errors.length > 0) {
    console.log(`\n❌ ${errors.length} validation error(s) found`);
    process.exit(1);
  }

  console.log('\n✅ Schema validation passed');
  process.exit(0);
}

main();
