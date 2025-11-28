import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../../prisma/prisma.service';
import type { Change } from '@prisma/client';
import { DiffOperation } from '../diff/json-diff.service';

interface ComponentForAnalysis {
  id: string;
  name: string;
  type: string;
  path: string | null;
  metadata: any;
}

export interface ImpactAnalysis {
  overallImpact: 'low' | 'medium' | 'high' | 'critical';
  complexityScore: number; // 0-100
  breakingChanges: number;
  affectedComponents: number;
  dependencies: Array<{
    componentId: string;
    componentName: string;
    componentType?: string;
    reason: string;
    impactLevel: 'low' | 'medium' | 'high' | 'critical';
  }>;
  riskFactors: Array<{
    factor: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    description: string;
  }>;
  [key: string]: any; // Index signature for Prisma JSON compatibility
}

@Injectable()
export class ImpactAnalyzerService {
  private readonly logger = new Logger(ImpactAnalyzerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /**
   * Analyze the impact of a change
   */
  async analyzeImpact(change: Change): Promise<ImpactAnalysis> {
    try {
      const diffSummary = change.diffSummary as any;

      if (!diffSummary) {
        return this.getEmptyAnalysis();
      }

      const operations: DiffOperation[] = diffSummary.operations || [];

      // Find affected components
      const dependencies = await this.findAffectedComponents(
        change.appId,
        change.organizationId,
        operations,
      );

      // Calculate complexity
      const complexityScore = this.calculateComplexity(diffSummary, operations);

      // Detect breaking changes
      const breakingChanges = this.detectBreakingChanges(operations);

      // Identify risk factors
      const riskFactors = this.identifyRiskFactors(diffSummary, operations, dependencies.length);

      // Calculate overall impact
      const overallImpact = this.calculateOverallImpact(
        complexityScore,
        breakingChanges,
        dependencies.length,
        riskFactors,
      );

      return {
        overallImpact,
        complexityScore,
        breakingChanges,
        affectedComponents: dependencies.length,
        dependencies,
        riskFactors,
      };
    } catch (error) {
      this.logger.error(`Failed to analyze impact: ${error.message}`, error.stack);
      return this.getEmptyAnalysis();
    }
  }

  /**
   * Find components affected by the change
   */
  private async findAffectedComponents(
    appId: string,
    organizationId: string,
    operations: DiffOperation[],
  ): Promise<ImpactAnalysis['dependencies']> {
    const dependencies: ImpactAnalysis['dependencies'] = [];

    // Get all components in the app
    const components = await this.prisma.component.findMany({
      where: {
        appId,
        app: {
          organizationId,
        },
      },
      select: {
        id: true,
        name: true,
        type: true,
        path: true,
        metadata: true,
      },
    });

    // Find deleted paths
    const deletedPaths = operations.filter((op) => op.op === 'remove').map((op) => op.path);

    // Find modified critical paths
    const modifiedCriticalPaths = operations
      .filter((op) => op.op === 'replace' && op.impact === 'high')
      .map((op) => op.path);

    // Check which components reference deleted/modified paths
    for (const component of components) {
      const metadata = component.metadata as any;

      // Check if component references deleted paths
      for (const deletedPath of deletedPaths) {
        if (this.componentReferencesPath(component, deletedPath, metadata)) {
          dependencies.push({
            componentId: component.id,
            componentName: component.name,
            componentType: component.type,
            reason: `References deleted ${this.extractEntityName(deletedPath)}`,
            impactLevel: 'critical',
          });
        }
      }

      // Check if component references modified critical paths
      for (const modifiedPath of modifiedCriticalPaths) {
        if (this.componentReferencesPath(component, modifiedPath, metadata)) {
          dependencies.push({
            componentId: component.id,
            componentName: component.name,
            componentType: component.type,
            reason: `Depends on modified ${this.extractEntityName(modifiedPath)}`,
            impactLevel: 'high',
          });
        }
      }
    }

    // Remove duplicates
    const uniqueDependencies = Array.from(
      new Map(dependencies.map((d) => [d.componentId, d])).values(),
    );

    return uniqueDependencies;
  }

  /**
   * Check if a component references a specific path
   */
  private componentReferencesPath(
    component: ComponentForAnalysis,
    path: string,
    metadata: any,
  ): boolean {
    const entityName = this.extractEntityName(path);

    // Check in component path
    if (component.path && component.path.includes(entityName)) {
      return true;
    }

    // Check in component name
    if (component.name && component.name.includes(entityName)) {
      return true;
    }

    // Check in metadata (as JSON string)
    if (metadata) {
      const metadataStr = JSON.stringify(metadata).toLowerCase();
      return metadataStr.includes(entityName.toLowerCase());
    }

    return false;
  }

  /**
   * Extract entity name from JSON path (e.g., /dataSources/UserAPI -> UserAPI)
   */
  private extractEntityName(path: string): string {
    const parts = path.split('/').filter((p) => p);
    return parts[parts.length - 1] || path;
  }

  /**
   * Calculate change complexity score (0-100)
   */
  private calculateComplexity(diffSummary: any, operations: DiffOperation[]): number {
    let score = 0;

    // Base score from change count
    const totalChanges = diffSummary.totalChanges || 0;
    score += Math.min(totalChanges * 2, 40); // Max 40 points for change count

    // Additional points for deletions (higher risk)
    const deletions = operations.filter((op) => op.op === 'remove').length;
    score += deletions * 5; // 5 points per deletion

    // Additional points for high/critical impact changes
    const highImpactChanges = operations.filter(
      (op) => op.impact === 'high' || op.impact === 'critical',
    ).length;
    score += highImpactChanges * 8; // 8 points per high-impact change

    // Additional points for multiple categories affected
    const categoriesCount = Object.keys(diffSummary.categories || {}).length;
    score += categoriesCount * 3; // 3 points per category

    return Math.min(Math.round(score), 100); // Cap at 100
  }

  /**
   * Detect breaking changes
   */
  private detectBreakingChanges(operations: DiffOperation[]): number {
    let breakingChanges = 0;

    for (const op of operations) {
      // Deletions are always breaking
      if (op.op === 'remove') {
        breakingChanges++;
      }

      // Critical replacements are breaking
      if (op.op === 'replace' && op.impact === 'critical') {
        breakingChanges++;
      }

      // Check for specific breaking patterns
      if (this.isBreakingChange(op)) {
        breakingChanges++;
      }
    }

    return breakingChanges;
  }

  /**
   * Check if an operation is a breaking change
   */
  private isBreakingChange(operation: DiffOperation): boolean {
    const breakingKeywords = [
      'schema',
      'interface',
      'contract',
      'api',
      'endpoint',
      'auth',
      'permission',
      'datasource',
      'connection',
    ];

    const path = operation.path.toLowerCase();
    return breakingKeywords.some((keyword) => path.includes(keyword));
  }

  /**
   * Identify risk factors
   */
  private identifyRiskFactors(
    diffSummary: any,
    operations: DiffOperation[],
    dependenciesCount: number,
  ): ImpactAnalysis['riskFactors'] {
    const riskFactors: ImpactAnalysis['riskFactors'] = [];

    // High number of changes
    const totalChanges = diffSummary.totalChanges || 0;
    if (totalChanges > 20) {
      riskFactors.push({
        factor: 'High Change Volume',
        severity: totalChanges > 50 ? 'critical' : 'high',
        description: `${totalChanges} total changes detected. Large changes increase risk of errors.`,
      });
    }

    // Deletions present
    const deletions = operations.filter((op) => op.op === 'remove').length;
    if (deletions > 0) {
      riskFactors.push({
        factor: 'Resource Deletions',
        severity: deletions > 5 ? 'high' : 'medium',
        description: `${deletions} resources deleted. May break dependent components.`,
      });
    }

    // Critical paths modified
    const criticalChanges = operations.filter((op) => op.impact === 'critical').length;
    if (criticalChanges > 0) {
      riskFactors.push({
        factor: 'Critical Components Modified',
        severity: 'critical',
        description: `${criticalChanges} critical components (auth, data, security) modified.`,
      });
    }

    // Many dependencies affected
    if (dependenciesCount > 0) {
      riskFactors.push({
        factor: 'Component Dependencies',
        severity: dependenciesCount > 10 ? 'high' : dependenciesCount > 5 ? 'medium' : 'low',
        description: `${dependenciesCount} components may be affected by this change.`,
      });
    }

    // Multiple categories affected
    const categoriesCount = Object.keys(diffSummary.categories || {}).length;
    if (categoriesCount > 3) {
      riskFactors.push({
        factor: 'Wide Scope',
        severity: 'medium',
        description: `Changes span ${categoriesCount} different categories. Harder to test thoroughly.`,
      });
    }

    return riskFactors;
  }

  /**
   * Calculate overall impact level
   */
  private calculateOverallImpact(
    complexityScore: number,
    breakingChanges: number,
    dependenciesCount: number,
    riskFactors: ImpactAnalysis['riskFactors'],
  ): 'low' | 'medium' | 'high' | 'critical' {
    // Critical if any critical risk factors
    if (riskFactors.some((f) => f.severity === 'critical')) {
      return 'critical';
    }

    // Critical if breaking changes + dependencies
    if (breakingChanges > 0 && dependenciesCount > 5) {
      return 'critical';
    }

    // High if complexity > 70 or breaking changes > 3
    if (complexityScore > 70 || breakingChanges > 3) {
      return 'high';
    }

    // High if many dependencies
    if (dependenciesCount > 10) {
      return 'high';
    }

    // Medium if complexity > 40 or some breaking changes
    if (complexityScore > 40 || breakingChanges > 0 || dependenciesCount > 3) {
      return 'medium';
    }

    return 'low';
  }

  /**
   * Get empty analysis (for error cases)
   */
  private getEmptyAnalysis(): ImpactAnalysis {
    return {
      overallImpact: 'low',
      complexityScore: 0,
      breakingChanges: 0,
      affectedComponents: 0,
      dependencies: [],
      riskFactors: [],
    };
  }
}
