import { Injectable, Logger } from '@nestjs/common';
import { compare, Operation } from 'fast-json-patch';
import * as Diff from 'diff';

export interface DiffOperation {
  op: 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test';
  path: string;
  value?: any;
  oldValue?: any;
  category?: string;
  impact?: 'low' | 'medium' | 'high' | 'critical';
}

export interface DiffSummary {
  totalChanges: number;
  added: number;
  modified: number;
  deleted: number;
  categories: Record<string, { added: number; modified: number; deleted: number }>;
  operations: DiffOperation[];
  [key: string]: any; // Index signature for Prisma JSON compatibility
}

@Injectable()
export class JsonDiffService {
  private readonly logger = new Logger(JsonDiffService.name);

  /**
   * Calculate JSON diff between two objects using fast-json-patch
   */
  calculateDiff(before: any, after: any): DiffSummary {
    try {
      // Handle null/undefined cases
      const beforeObj = before || {};
      const afterObj = after || {};

      // Calculate JSON patch operations
      const operations: Operation[] = compare(beforeObj, afterObj);

      // Categorize operations
      const added = operations.filter((op) => op.op === 'add').length;
      const modified = operations.filter((op) => op.op === 'replace').length;
      const deleted = operations.filter((op) => op.op === 'remove').length;

      // Extract old values for remove/replace operations
      const enrichedOperations: DiffOperation[] = operations.map((op) => {
        const enriched: DiffOperation = {
          op: op.op as any,
          path: op.path,
          value: 'value' in op ? op.value : undefined,
        };

        // Extract old value for replace operations
        if (op.op === 'replace' || op.op === 'remove') {
          enriched.oldValue = this.getValueAtPath(beforeObj, op.path);
        }

        // Categorize by path (e.g., /screens/LoginScreen -> "screens")
        enriched.category = this.extractCategory(op.path);

        // Assess impact based on operation and path
        enriched.impact = this.assessImpact(op);

        return enriched;
      });

      // Group by category
      const categories = this.groupByCategory(enrichedOperations);

      return {
        totalChanges: operations.length,
        added,
        modified,
        deleted,
        categories,
        operations: enrichedOperations,
      };
    } catch (error) {
      this.logger.error(`Failed to calculate diff: ${error.message}`, error.stack);
      throw error;
    }
  }

  /**
   * Generate visual diff for JSON objects (for display)
   */
  generateVisualDiff(before: any, after: any): string {
    const beforeStr = JSON.stringify(before, null, 2) || '{}';
    const afterStr = JSON.stringify(after, null, 2) || '{}';

    return this.generateTextDiff(beforeStr, afterStr);
  }

  /**
   * Generate text-based diff (supports JSON, code, etc.)
   */
  generateTextDiff(before: string, after: string): string {
    const diff = Diff.diffLines(before || '', after || '');

    return diff
      .map((part) => {
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';
        return part.value
          .split('\n')
          .filter((line) => line)
          .map((line) => `${prefix}${line}`)
          .join('\n');
      })
      .join('\n');
  }

  /**
   * Generate HTML diff for web display
   */
  generateHtmlDiff(before: string, after: string): string {
    const diff = Diff.diffLines(before || '', after || '');

    return diff
      .map((part) => {
        const color = part.added ? 'green' : part.removed ? 'red' : 'gray';
        const backgroundColor = part.added
          ? '#e6ffed'
          : part.removed
            ? '#ffeef0'
            : 'transparent';
        const prefix = part.added ? '+ ' : part.removed ? '- ' : '  ';

        return part.value
          .split('\n')
          .filter((line) => line)
          .map(
            (line) =>
              `<div style="color: ${color}; background-color: ${backgroundColor}; padding: 2px 4px; font-family: monospace;">${this.escapeHtml(prefix + line)}</div>`,
          )
          .join('');
      })
      .join('');
  }

  /**
   * Extract paths that changed
   */
  extractChangedPaths(operations: DiffOperation[]): string[] {
    return operations.map((op) => op.path);
  }

  /**
   * Check if a specific path changed
   */
  hasPathChanged(operations: DiffOperation[], path: string): boolean {
    return operations.some((op) => op.path.startsWith(path));
  }

  /**
   * Get all operations for a specific path
   */
  getOperationsForPath(operations: DiffOperation[], path: string): DiffOperation[] {
    return operations.filter((op) => op.path.startsWith(path));
  }

  /**
   * Get value at JSON path
   */
  private getValueAtPath(obj: any, path: string): any {
    const parts = path.split('/').filter((p) => p);
    let current = obj;

    for (const part of parts) {
      if (current === undefined || current === null) return undefined;
      current = current[part];
    }

    return current;
  }

  /**
   * Extract category from path (e.g., /screens/LoginScreen -> "screens")
   */
  private extractCategory(path: string): string {
    const parts = path.split('/').filter((p) => p);
    return parts[0] || 'general';
  }

  /**
   * Assess impact of a change
   */
  private assessImpact(operation: Operation): 'low' | 'medium' | 'high' | 'critical' {
    // Deletions are higher impact
    if (operation.op === 'remove') {
      // Check if it's a critical component (data source, authentication, etc.)
      if (this.isCriticalPath(operation.path)) {
        return 'critical';
      }
      return 'high';
    }

    // Additions are lower impact
    if (operation.op === 'add') {
      return 'low';
    }

    // Replacements depend on what's being replaced
    if (operation.op === 'replace') {
      if (this.isCriticalPath(operation.path)) {
        return 'high';
      }
      return 'medium';
    }

    return 'low';
  }

  /**
   * Check if a path is critical (security, data, auth)
   */
  private isCriticalPath(path: string): boolean {
    const criticalKeywords = [
      'auth',
      'security',
      'permission',
      'role',
      'datasource',
      'connection',
      'api',
      'endpoint',
      'secret',
      'password',
      'token',
    ];

    const lowerPath = path.toLowerCase();
    return criticalKeywords.some((keyword) => lowerPath.includes(keyword));
  }

  /**
   * Group operations by category
   */
  private groupByCategory(
    operations: DiffOperation[],
  ): Record<string, { added: number; modified: number; deleted: number }> {
    const categories: Record<string, { added: number; modified: number; deleted: number }> = {};

    for (const op of operations) {
      const category = op.category || 'general';

      if (!categories[category]) {
        categories[category] = { added: 0, modified: 0, deleted: 0 };
      }

      if (op.op === 'add') {
        categories[category].added++;
      } else if (op.op === 'replace') {
        categories[category].modified++;
      } else if (op.op === 'remove') {
        categories[category].deleted++;
      }
    }

    return categories;
  }

  /**
   * Escape HTML for safe display
   */
  private escapeHtml(text: string): string {
    const map: Record<string, string> = {
      '&': '&amp;',
      '<': '&lt;',
      '>': '&gt;',
      '"': '&quot;',
      "'": '&#039;',
    };
    return text.replace(/[&<>"']/g, (m) => map[m]);
  }
}
