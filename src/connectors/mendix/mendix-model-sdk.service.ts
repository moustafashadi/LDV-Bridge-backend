import { Injectable, Logger } from '@nestjs/common';
import { MendixPlatformClient, OnlineWorkingCopy } from 'mendixplatformsdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Mendix Model SDK Service
 * Exports full Mendix model (pages, microflows, entities, nanoflows) using the Mendix Model SDK
 */
@Injectable()
export class MendixModelSdkService {
  private readonly logger = new Logger(MendixModelSdkService.name);

  /**
   * Export full Mendix model to a directory structure
   * Creates JSON files for all model elements (pages, microflows, entities, etc.)
   */
  async exportFullModel(
    mendixAppId: string,
    pat: string,
    branchName: string = 'main',
  ): Promise<string> {
    this.logger.log(`[SDK] Starting full model export for app ${mendixAppId}`);

    // Create export directory
    const exportDir = path.join(
      os.tmpdir(),
      `mendix-model-${mendixAppId}-${Date.now()}`,
    );
    fs.mkdirSync(exportDir, { recursive: true });

    let workingCopy: OnlineWorkingCopy | null = null;
    const originalToken = process.env.MENDIX_TOKEN;

    try {
      // Set PAT as environment variable (SDK reads from MENDIX_TOKEN)
      process.env.MENDIX_TOKEN = pat;

      // Initialize SDK client
      this.logger.log(`[SDK] Initializing Mendix Platform Client...`);
      const client = new MendixPlatformClient();

      // Get the app
      this.logger.log(`[SDK] Getting app ${mendixAppId}...`);
      const app = await client.getApp(mendixAppId);

      // Create temporary working copy
      this.logger.log(
        `[SDK] Creating temporary working copy from branch '${branchName}'...`,
      );
      workingCopy = await app.createTemporaryWorkingCopy(branchName);

      // Open the model
      this.logger.log(`[SDK] Opening model...`);
      const model = await workingCopy.openModel();

      // Create subdirectories
      const dirs = {
        domainModel: path.join(exportDir, 'domain-model'),
        pages: path.join(exportDir, 'pages'),
        microflows: path.join(exportDir, 'microflows'),
        nanoflows: path.join(exportDir, 'nanoflows'),
        constants: path.join(exportDir, 'constants'),
      };

      for (const dir of Object.values(dirs)) {
        fs.mkdirSync(dir, { recursive: true });
      }

      // Export domain models (entities)
      this.logger.log(`[SDK] Exporting domain models...`);
      const domainModels = model.allDomainModels();
      for (const dm of domainModels) {
        try {
          const loadedDm = await dm.load();
          const moduleName = (dm as any).containerAsModule?.name || 'unknown';
          const dmData = loadedDm as any;

          const entities = (dmData.entities || []).map((entity: any) => ({
            name: entity.name,
            documentation: entity.documentation,
            generalization: entity.generalization?.qualifiedName,
            attributes: (entity.attributes || []).map((attr: any) => ({
              name: attr.name,
              type: attr.type?.constructor?.name || String(attr.type),
              documentation: attr.documentation,
            })),
          }));

          const associations = (dmData.associations || []).map(
            (assoc: any) => ({
              name: assoc.name,
              parent: assoc.parent?.qualifiedName,
              child: assoc.child?.qualifiedName,
              type: assoc.type?.name || String(assoc.type),
            }),
          );

          fs.writeFileSync(
            path.join(dirs.domainModel, `${moduleName}.json`),
            JSON.stringify({ moduleName, entities, associations }, null, 2),
          );
        } catch (err) {
          this.logger.debug(
            `[SDK] Could not load domain model: ${(err as any).message}`,
          );
        }
      }

      // Export pages
      this.logger.log(`[SDK] Exporting pages...`);
      const pages = model.allPages();
      for (const page of pages) {
        try {
          const loadedPage = await page.load();
          const moduleName = (page as any).containerAsModule?.name || 'unknown';
          const moduleDir = path.join(dirs.pages, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          const pageData = loadedPage as any;
          fs.writeFileSync(
            path.join(moduleDir, `${page.name}.json`),
            JSON.stringify(
              {
                name: page.name,
                documentation: pageData.documentation,
                layoutCall: pageData.layoutCall?.layout?.qualifiedName,
                url: pageData.url,
                allowedRoles: pageData.allowedRoles?.map(
                  (r: any) => r.qualifiedName,
                ),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          this.logger.debug(
            `[SDK] Could not load page ${page.name}: ${(err as any).message}`,
          );
        }
      }

      // Export microflows
      this.logger.log(`[SDK] Exporting microflows...`);
      const microflows = model.allMicroflows();
      for (const mf of microflows) {
        try {
          const loadedMf = await mf.load();
          const moduleName = (mf as any).containerAsModule?.name || 'unknown';
          const moduleDir = path.join(dirs.microflows, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          // Use any casts for dynamic SDK properties
          const mfData = loadedMf as any;

          fs.writeFileSync(
            path.join(moduleDir, `${mf.name}.json`),
            JSON.stringify(
              {
                name: mf.name,
                documentation: mfData.documentation,
                returnType: mfData.microflowReturnType?.constructor?.name,
                parameters: mfData.objectCollection?.objects?.map((o: any) => ({
                  name: o.name,
                  type: o.variableType?.constructor?.name || o.type,
                })),
                allowedRoles: mfData.allowedModuleRoles?.map(
                  (r: any) => r.qualifiedName,
                ),
              },
              null,
              2,
            ),
          );
        } catch (err) {
          this.logger.debug(
            `[SDK] Could not load microflow ${mf.name}: ${(err as any).message}`,
          );
        }
      }

      // Export nanoflows
      this.logger.log(`[SDK] Exporting nanoflows...`);
      const nanoflows = model.allNanoflows();
      for (const nf of nanoflows) {
        try {
          const loadedNf = await nf.load();
          const moduleName = (nf as any).containerAsModule?.name || 'unknown';
          const moduleDir = path.join(dirs.nanoflows, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          const nfData = loadedNf as any;
          fs.writeFileSync(
            path.join(moduleDir, `${nf.name}.json`),
            JSON.stringify(
              {
                name: nf.name,
                documentation: nfData.documentation,
                returnType: nfData.returnType?.constructor?.name,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          this.logger.debug(
            `[SDK] Could not load nanoflow ${nf.name}: ${(err as any).message}`,
          );
        }
      }

      // Export constants
      this.logger.log(`[SDK] Exporting constants...`);
      const constants = model.allConstants();
      for (const constant of constants) {
        try {
          const loadedConst = await constant.load();
          const moduleName =
            (constant as any).containerAsModule?.name || 'unknown';
          const moduleDir = path.join(dirs.constants, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          const constData = loadedConst as any;
          fs.writeFileSync(
            path.join(moduleDir, `${constant.name}.json`),
            JSON.stringify(
              {
                name: constant.name,
                documentation: constData.documentation,
                type: constData.type?.constructor?.name,
                defaultValue: constData.defaultValue,
              },
              null,
              2,
            ),
          );
        } catch (err) {
          this.logger.debug(
            `[SDK] Could not load constant ${constant.name}: ${(err as any).message}`,
          );
        }
      }

      // Create summary file
      const summary = {
        appId: mendixAppId,
        branch: branchName,
        exportedAt: new Date().toISOString(),
        counts: {
          domainModels: domainModels.length,
          pages: pages.length,
          microflows: microflows.length,
          nanoflows: nanoflows.length,
          constants: constants.length,
        },
      };

      fs.writeFileSync(
        path.join(exportDir, 'model-summary.json'),
        JSON.stringify(summary, null, 2),
      );

      // Create README
      fs.writeFileSync(
        path.join(exportDir, 'README.md'),
        `# Mendix Model Export

**App ID:** ${mendixAppId}
**Branch:** ${branchName}
**Exported:** ${summary.exportedAt}

## Contents

| Type | Count |
|------|-------|
| Domain Models | ${summary.counts.domainModels} |
| Pages | ${summary.counts.pages} |
| Microflows | ${summary.counts.microflows} |
| Nanoflows | ${summary.counts.nanoflows} |
| Constants | ${summary.counts.constants} |

---
*Exported by LDV Bridge using Mendix Model SDK*
`,
      );

      this.logger.log(`[SDK] Export complete: ${exportDir}`);
      return exportDir;
    } catch (error) {
      this.logger.error(
        `[SDK] Export failed: ${(error as any).message}`,
        (error as any).stack,
      );
      // Clean up on failure
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
      } catch {}
      throw error;
    } finally {
      // Restore original MENDIX_TOKEN
      if (originalToken !== undefined) {
        process.env.MENDIX_TOKEN = originalToken;
      } else {
        delete process.env.MENDIX_TOKEN;
      }
    }
  }
}
