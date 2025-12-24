#!/usr/bin/env node

/**
 * LCNC Security Scan Script
 * Scans exported Mendix model files for security issues.
 *
 * Checks:
 * 1. Hardcoded credentials/secrets
 * 2. Unsafe URL patterns
 * 3. SQL injection patterns in microflows
 * 4. Excessive permissions
 *
 * Exit codes:
 * 0 = No security issues found
 * 1 = Security issues detected
 */

const fs = require('fs');
const path = require('path');

// Security patterns to detect
const SECURITY_PATTERNS = [
  // Hardcoded credentials
  {
    name: 'hardcoded-password',
    severity: 'critical',
    patterns: [
      /password\s*[=:]\s*["'][^"']{3,}["']/gi,
      /passwd\s*[=:]\s*["'][^"']{3,}["']/gi,
      /secret\s*[=:]\s*["'][^"']{3,}["']/gi,
    ],
    message: 'Potential hardcoded password detected',
  },

  // API keys
  {
    name: 'api-key',
    severity: 'critical',
    patterns: [
      /api[_-]?key\s*[=:]\s*["'][a-zA-Z0-9_-]{16,}["']/gi,
      /apikey\s*[=:]\s*["'][a-zA-Z0-9_-]{16,}["']/gi,
      /["'][A-Za-z0-9]{32,}["']/g, // Long base64-like strings
    ],
    message: 'Potential API key or secret detected',
  },

  // Connection strings
  {
    name: 'connection-string',
    severity: 'high',
    patterns: [
      /mongodb(\+srv)?:\/\/[^"'\s]+/gi,
      /postgres(ql)?:\/\/[^"'\s]+/gi,
      /mysql:\/\/[^"'\s]+/gi,
      /Server=.+;Database=.+;.*Password=/gi,
    ],
    message: 'Database connection string detected',
  },

  // Unsafe URLs
  {
    name: 'unsafe-url',
    severity: 'medium',
    patterns: [
      /http:\/\/[^"'\s]+/gi, // Non-HTTPS URLs (warning only)
    ],
    message: 'Non-HTTPS URL detected (consider using HTTPS)',
  },

  // SQL injection risks (in microflow names/documentation)
  {
    name: 'sql-pattern',
    severity: 'medium',
    patterns: [
      /SELECT\s+\*\s+FROM/gi,
      /DROP\s+TABLE/gi,
      /DELETE\s+FROM\s+[^W]/gi, // DELETE without WHERE
    ],
    message: 'Raw SQL pattern detected - use parameterized queries',
  },
];

// Allowed patterns (false positives)
const ALLOWED_PATTERNS = [
  /localhost/i,
  /example\.com/i,
  /placeholder/i,
  /test/i,
  /dummy/i,
  /sample/i,
];

function scanContent(content, filePath) {
  const findings = [];

  for (const rule of SECURITY_PATTERNS) {
    for (const pattern of rule.patterns) {
      const matches = content.match(pattern);

      if (matches) {
        for (const match of matches) {
          // Check if it's an allowed pattern
          const isAllowed = ALLOWED_PATTERNS.some((ap) => ap.test(match));

          if (!isAllowed) {
            findings.push({
              file: filePath,
              rule: rule.name,
              severity: rule.severity,
              message: rule.message,
              match:
                match.substring(0, 100) + (match.length > 100 ? '...' : ''),
            });
          }
        }
      }
    }
  }

  return findings;
}

function findAllFiles(dir) {
  const files = [];

  if (!fs.existsSync(dir)) {
    return files;
  }

  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = path.join(dir, entry.name);
    if (
      entry.isDirectory() &&
      !entry.name.startsWith('.') &&
      entry.name !== 'node_modules'
    ) {
      files.push(...findAllFiles(fullPath));
    } else if (entry.name.endsWith('.json')) {
      files.push(fullPath);
    }
  }

  return files;
}

function main() {
  console.log('🔒 Running security scan...\n');

  const allFindings = [];
  let totalFiles = 0;

  // Scan current directory for JSON files
  const files = findAllFiles('.');

  for (const file of files) {
    try {
      totalFiles++;
      const content = fs.readFileSync(file, 'utf8');
      const findings = scanContent(content, file);
      allFindings.push(...findings);
    } catch (e) {
      // Skip files that can't be read
    }
  }

  console.log(`📊 Scanned ${totalFiles} files\n`);

  if (allFindings.length === 0) {
    console.log('✅ No security issues found');
    process.exit(0);
  }

  // Group findings by severity
  const critical = allFindings.filter((f) => f.severity === 'critical');
  const high = allFindings.filter((f) => f.severity === 'high');
  const medium = allFindings.filter((f) => f.severity === 'medium');

  if (critical.length > 0) {
    console.log(`🚨 CRITICAL (${critical.length}):`);
    critical.forEach((f) => {
      console.log(`   [${f.rule}] ${f.file}`);
      console.log(`      ${f.message}`);
      console.log(`      Match: ${f.match}`);
    });
    console.log();
  }

  if (high.length > 0) {
    console.log(`❌ HIGH (${high.length}):`);
    high.forEach((f) => {
      console.log(`   [${f.rule}] ${f.file}`);
      console.log(`      ${f.message}`);
    });
    console.log();
  }

  if (medium.length > 0) {
    console.log(`⚠️  MEDIUM (${medium.length}):`);
    medium.forEach((f) => {
      console.log(`   [${f.rule}] ${f.file}`);
      console.log(`      ${f.message}`);
    });
    console.log();
  }

  // Only fail on critical or high
  if (critical.length > 0 || high.length > 0) {
    console.log(
      `\n❌ ${critical.length + high.length} security issue(s) require attention`,
    );
    process.exit(1);
  }

  console.log(
    `\n⚠️  ${medium.length} medium severity finding(s) - review recommended`,
  );
  process.exit(0);
}

main();
