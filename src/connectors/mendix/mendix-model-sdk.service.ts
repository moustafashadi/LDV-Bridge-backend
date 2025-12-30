import { Injectable, Logger } from '@nestjs/common';
import {
  MendixPlatformClient,
  OnlineWorkingCopy,
  setPlatformConfig,
} from 'mendixplatformsdk';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import simpleGit, { SimpleGit } from 'simple-git';

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
   *
   * @param mendixAppId - The Mendix app ID (subdomain like "ldv-bridgex") - used for logging only
   * @param pat - The Personal Access Token for Mendix Platform SDK
   * @param branchName - The branch name to export (default: 'main')
   * @param projectId - The Mendix project UUID (required by Platform SDK). If not provided, falls back to mendixAppId
   */
  async exportFullModel(
    mendixAppId: string,
    pat: string,
    branchName: string = 'main',
    projectId?: string,
  ): Promise<string> {
    // The Platform SDK requires the projectId (UUID), not the appId (subdomain)
    const sdkAppId = projectId || mendixAppId;
    this.logger.log(
      `[SDK] Starting full model export for app ${mendixAppId} (projectId: ${sdkAppId})`,
    );

    // Create export directory
    const exportDir = path.join(
      os.tmpdir(),
      `mendix-model-${mendixAppId}-${Date.now()}`,
    );
    fs.mkdirSync(exportDir, { recursive: true });

    let workingCopy: OnlineWorkingCopy | null = null;
    const originalToken = process.env.MENDIX_TOKEN;

    try {
      // Configure the Platform SDK with the PAT BEFORE creating the client
      // This is the correct way to pass the token - setPlatformConfig must be called first
      this.logger.log(
        `[SDK] Configuring Platform SDK with PAT (length: ${pat?.length || 0}, starts with: ${pat?.substring(0, 8)}...)...`,
      );

      if (!pat || pat.length < 10) {
        throw new Error('Invalid or missing PAT token');
      }

      setPlatformConfig({
        mendixToken: pat,
      });

      // Also set environment variable as fallback
      process.env.MENDIX_TOKEN = pat;

      // Initialize SDK client (will now use the configured token)
      this.logger.log(`[SDK] Initializing Mendix Platform Client...`);
      const client = new MendixPlatformClient();

      // Get the app using projectId (UUID), not appId (subdomain)
      this.logger.log(`[SDK] Getting app ${sdkAppId} (projectId)...`);
      const app = await client.getApp(sdkAppId);

      // Create temporary working copy
      this.logger.log(
        `[SDK] Creating temporary working copy from branch '${branchName}'...`,
      );
      try {
        workingCopy = await app.createTemporaryWorkingCopy(branchName);
      } catch (workingCopyError) {
        // Check for 403 Forbidden - usually means missing PAT scopes
        if (workingCopyError.message?.includes('403')) {
          this.logger.error(
            `[SDK] 403 Forbidden when creating working copy. PAT may be missing required scopes.`,
          );
          throw new Error(
            `Access denied when creating working copy. Your Mendix Personal Access Token (PAT) may be missing the required 'mx:modelrepository:repo:write' scope. ` +
              `Please regenerate your PAT with the following scopes: mx:modelrepository:repo:read, mx:modelrepository:repo:write, mx:app:create, mx:app:delete. ` +
              `Then reconnect your Mendix account in Settings.`,
          );
        }
        throw workingCopyError;
      }

      // Open the model
      this.logger.log(`[SDK] Opening model...`);
      const model = await workingCopy.openModel();

      // Log all modules for debugging
      const allModules = model.allModules();
      const moduleNames = allModules.map((m) => m.name);
      this.logger.log(
        `[SDK] Found ${moduleNames.length} modules: ${moduleNames.join(', ')}`,
      );

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

      // Track exported counts and skipped counts
      let exportedDomainModels = 0;
      let exportedPages = 0;
      let exportedMicroflows = 0;
      let exportedNanoflows = 0;
      let exportedConstants = 0;
      let skippedElements = 0;

      // Helper to safely get module name from element
      // Uses containerAsModule if available, otherwise extracts from qualifiedName
      const getModuleName = (element: any): string => {
        try {
          // First try containerAsModule
          if (element.containerAsModule?.name) {
            return element.containerAsModule.name;
          }
        } catch {
          // containerAsModule threw an error, try qualifiedName
        }

        try {
          // Fallback: extract from qualifiedName (format: "ModuleName.ElementName")
          if (element.qualifiedName) {
            const parts = element.qualifiedName.split('.');
            if (parts.length >= 2) {
              return parts[0];
            }
          }
        } catch {
          // qualifiedName also failed
        }

        return 'unknown';
      };

      // Export domain models (entities) - try all, skip on failure
      this.logger.log(`[SDK] Exporting domain models...`);
      const domainModels = model.allDomainModels();
      for (const dm of domainModels) {
        try {
          const loadedDm = await dm.load();
          const moduleName = getModuleName(dm) || 'unknown';
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
          exportedDomainModels++;
        } catch (err) {
          skippedElements++;
          this.logger.debug(
            `[SDK] Skipped domain model (not accessible): ${(err as any).message}`,
          );
        }
      }

      // Export pages - try all, skip on failure
      this.logger.log(`[SDK] Exporting pages...`);
      const pages = model.allPages();
      for (const page of pages) {
        try {
          const loadedPage = await page.load();
          const moduleName = getModuleName(page) || 'unknown';
          const moduleDir = path.join(dirs.pages, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          const pageData = loadedPage as any;

          // Extract page title - it's a Text object with translations
          let pageTitle = null;
          if (pageData.title) {
            try {
              // Title is a texts.Text object - extract translations
              const titleObj = pageData.title;
              if (titleObj.translations && titleObj.translations.length > 0) {
                // Get all translations
                pageTitle = titleObj.translations.map((t: any) => ({
                  languageCode: t.languageCode,
                  text: t.text,
                }));
              }
            } catch (titleErr) {
              this.logger.debug(
                `[SDK] Could not extract title for page ${page.name}`,
              );
            }
          }

          fs.writeFileSync(
            path.join(moduleDir, `${page.name}.json`),
            JSON.stringify(
              {
                name: page.name,
                title: pageTitle,
                documentation: pageData.documentation,
                layoutCall: pageData.layoutCall?.layout?.qualifiedName,
                url: pageData.url,
                allowedRoles: pageData.allowedRoles?.map(
                  (r: any) => r.qualifiedName,
                ),
                popupWidth: pageData.popupWidth,
                popupHeight: pageData.popupHeight,
                popupResizable: pageData.popupResizable,
              },
              null,
              2,
            ),
          );
          exportedPages++;
        } catch (err) {
          skippedElements++;
          this.logger.debug(
            `[SDK] Skipped page ${page.name}: ${(err as any).message}`,
          );
        }
      }

      // Export microflows - try all, skip on failure
      this.logger.log(`[SDK] Exporting microflows...`);
      const microflows = model.allMicroflows();
      for (const mf of microflows) {
        try {
          const loadedMf = await mf.load();
          const moduleName = getModuleName(mf) || 'unknown';
          const moduleDir = path.join(dirs.microflows, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

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
          exportedMicroflows++;
        } catch (err) {
          skippedElements++;
          this.logger.debug(
            `[SDK] Skipped microflow ${mf.name}: ${(err as any).message}`,
          );
        }
      }

      // Export nanoflows - try all, skip on failure
      this.logger.log(`[SDK] Exporting nanoflows...`);
      const nanoflows = model.allNanoflows();
      for (const nf of nanoflows) {
        try {
          const loadedNf = await nf.load();
          const moduleName = getModuleName(nf) || 'unknown';
          const moduleDir = path.join(dirs.nanoflows, moduleName);
          fs.mkdirSync(moduleDir, { recursive: true });

          const nfData = loadedNf as any;
          fs.writeFileSync(
            path.join(moduleDir, `${nf.name}.json`),
            JSON.stringify(
              {
                name: nf.name,
                documentation: nfData.documentation,
                // Use microflowReturnType (returnType was deprecated in Mendix 7.9.0)
                returnType: nfData.microflowReturnType?.constructor?.name,
              },
              null,
              2,
            ),
          );
          exportedNanoflows++;
        } catch (err) {
          skippedElements++;
          this.logger.debug(
            `[SDK] Skipped nanoflow ${nf.name}: ${(err as any).message}`,
          );
        }
      }

      // Export constants - try all, skip on failure
      this.logger.log(`[SDK] Exporting constants...`);
      const constants = model.allConstants();
      for (const constant of constants) {
        try {
          const loadedConst = await constant.load();
          const moduleName = getModuleName(constant) || 'unknown';
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
          exportedConstants++;
        } catch (err) {
          skippedElements++;
          this.logger.debug(
            `[SDK] Skipped constant ${constant.name}: ${(err as any).message}`,
          );
        }
      }

      // Create summary file with exported counts
      this.logger.log(
        `[SDK] Export complete: ${exportedDomainModels} domain models, ${exportedPages} pages, ${exportedMicroflows} microflows, ${exportedNanoflows} nanoflows, ${exportedConstants} constants. Skipped ${skippedElements} inaccessible elements.`,
      );

      const summary = {
        appId: mendixAppId,
        branch: branchName,
        exportedAt: new Date().toISOString(),
        modules: moduleNames,
        counts: {
          domainModels: exportedDomainModels,
          pages: exportedPages,
          microflows: exportedMicroflows,
          nanoflows: exportedNanoflows,
          constants: exportedConstants,
        },
        totalElementsInProject: {
          domainModels: domainModels.length,
          pages: pages.length,
          microflows: microflows.length,
          nanoflows: nanoflows.length,
          constants: constants.length,
        },
        skippedElements,
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

## Modules

${summary.modules.length > 0 ? summary.modules.map((m: string) => `- ${m}`).join('\n') : '_No modules found_'}

## Exported Contents

| Type | Exported | Total in Project |
|------|----------|------------------|
| Domain Models | ${summary.counts.domainModels} | ${summary.totalElementsInProject.domainModels} |
| Pages | ${summary.counts.pages} | ${summary.totalElementsInProject.pages} |
| Microflows | ${summary.counts.microflows} | ${summary.totalElementsInProject.microflows} |
| Nanoflows | ${summary.counts.nanoflows} | ${summary.totalElementsInProject.nanoflows} |
| Constants | ${summary.counts.constants} | ${summary.totalElementsInProject.constants} |

> **Note:** ${summary.skippedElements} elements were skipped because they are from system/marketplace modules that are not directly accessible via the Mendix Model SDK.

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

  /**
   * Export Mendix project by cloning the actual Git repository from Team Server
   * This provides the real Mendix project files (mprcontents, javascriptsource, themesource, etc.)
   * which enables proper change detection and diffs.
   *
   * @param projectId - The Mendix project UUID (e.g., "9f383554-798d-4ec7-8b63-b499c8bfb425")
   * @param pat - The Personal Access Token for Mendix Git access
   * @param branchName - The branch name to checkout (default: 'main')
   * @param mendixAppId - The app ID for logging purposes
   */
  async exportViaGitClone(
    projectId: string,
    pat: string,
    branchName: string = 'main',
    mendixAppId?: string,
  ): Promise<string> {
    const appLabel = mendixAppId || projectId;
    this.logger.log(
      `[GIT] Starting Git clone export for app ${appLabel} (projectId: ${projectId})`,
    );

    // Create export directory
    const exportDir = path.join(
      os.tmpdir(),
      `mendix-git-${appLabel}-${Date.now()}`,
    );
    fs.mkdirSync(exportDir, { recursive: true });

    try {
      // Mendix Team Server Git URL format
      const gitUrl = `https://git.api.mendix.com/${projectId}.git`;

      this.logger.log(`[GIT] Cloning from ${gitUrl} branch '${branchName}'...`);

      // Configure Git with PAT authentication and long path support
      const git: SimpleGit = simpleGit();

      // Enable long paths for Windows (path > 260 chars)
      // This is needed because Mendix projects have deeply nested node_modules
      try {
        await git.raw(['config', '--global', 'core.longpaths', 'true']);
        this.logger.log(
          `[GIT] Enabled core.longpaths for Windows long path support`,
        );
      } catch (configError) {
        this.logger.warn(
          `[GIT] Could not set core.longpaths: ${(configError as any).message}`,
        );
      }

      // Clone with embedded credentials (PAT as password, any username works)
      const authUrl = `https://pat:${pat}@git.api.mendix.com/${projectId}.git`;

      // Use sparse checkout to exclude node_modules (which cause long path issues on Windows)
      // First, init an empty repo with sparse checkout enabled
      const repoGit = simpleGit(exportDir);
      await repoGit.init();
      await repoGit.raw(['config', 'core.longpaths', 'true']);
      await repoGit.raw(['config', 'core.sparseCheckout', 'true']);
      await repoGit.addRemote('origin', authUrl);

      // Configure sparse checkout to exclude problematic paths
      const sparseCheckoutPath = path.join(
        exportDir,
        '.git',
        'info',
        'sparse-checkout',
      );
      fs.mkdirSync(path.dirname(sparseCheckoutPath), { recursive: true });
      fs.writeFileSync(
        sparseCheckoutPath,
        `/*
!**/node_modules/
`,
      );

      this.logger.log(
        `[GIT] Fetching branch '${branchName}' with sparse checkout...`,
      );

      // Add timeout to prevent hanging on slow/large repos (2 minutes)
      const GIT_TIMEOUT_MS = 120_000;

      // Create new git instance WITH timeout configuration
      const gitWithTimeout = simpleGit(exportDir, {
        timeout: {
          block: GIT_TIMEOUT_MS, // Max time for any single git operation
        },
      });

      // Re-apply config on the new instance
      await gitWithTimeout.raw(['config', 'core.longpaths', 'true']);
      await gitWithTimeout.raw(['config', 'core.sparseCheckout', 'true']);

      try {
        await gitWithTimeout.fetch('origin', branchName, ['--depth', '1']);
        await gitWithTimeout.checkout([`origin/${branchName}`, '--']);
      } catch (gitError) {
        const errorMessage = (gitError as Error).message || String(gitError);
        const isTimeout =
          errorMessage.includes('timed out') ||
          errorMessage.includes('ETIMEDOUT') ||
          errorMessage.includes('timeout');

        this.logger.error(
          `[GIT] Git operation failed: ${errorMessage}${isTimeout ? ' (TIMEOUT)' : ''}`,
        );

        // Clean up temp directory on failure
        try {
          fs.rmSync(exportDir, { recursive: true, force: true });
        } catch {}

        if (isTimeout) {
          throw new Error(
            `Git clone timed out after ${GIT_TIMEOUT_MS / 1000} seconds. The repository may be too large or the network is slow. Please try again.`,
          );
        }
        throw gitError;
      }

      this.logger.log(`[GIT] Clone complete. Processing files...`);

      // Remove .git directory to avoid pushing Mendix's git history
      const gitDir = path.join(exportDir, '.git');
      if (fs.existsSync(gitDir)) {
        fs.rmSync(gitDir, { recursive: true, force: true });
        this.logger.log(`[GIT] Removed .git directory`);
      }

      // Remove ignored files/folders that shouldn't be synced to GitHub
      const ignoredPaths = [
        '.mendix-cache',
        'deployment',
        'releases',
        'packages',
        'project-settings.user.json',
        'App.mpr.lock',
        'App.mpr.bak',
        '.svn',
      ];

      for (const ignored of ignoredPaths) {
        const ignoredPath = path.join(exportDir, ignored);
        if (fs.existsSync(ignoredPath)) {
          fs.rmSync(ignoredPath, { recursive: true, force: true });
          this.logger.log(`[GIT] Removed ignored path: ${ignored}`);
        }
      }

      // Remove all node_modules folders recursively (they cause long path issues on Windows
      // and shouldn't be synced anyway per .gitignore)
      this.removeNodeModulesRecursive(exportDir);
      this.logger.log(`[GIT] Removed all node_modules folders`);

      // Now add JSON exports for human-readable diffs
      // This uses the Model SDK to extract structured data from the binary .mxunit files
      this.logger.log(`[GIT] Adding JSON model exports for diff-ability...`);
      this.logger.log(`[GIT] ProjectId: ${projectId}, Branch: ${branchName}`);
      try {
        await this.addJsonModelExports(exportDir, projectId, pat, branchName);
        this.logger.log(`[GIT] JSON model exports added successfully`);
      } catch (jsonExportError) {
        const errorMessage =
          (jsonExportError as any).message || String(jsonExportError);
        const errorStack = (jsonExportError as any).stack || '';
        this.logger.warn(`[GIT] Failed to add JSON exports: ${errorMessage}`);
        this.logger.warn(`[GIT] JSON export error stack: ${errorStack}`);
        // Continue without JSON exports - Git clone still provides the raw files
      }

      // Generate summary README
      const stats = this.countProjectFiles(exportDir);
      const summaryPath = path.join(exportDir, 'README.md');
      fs.writeFileSync(
        summaryPath,
        `# Mendix Model Export

**App ID:** ${appLabel}
**Branch:** ${branchName}
**Exported:** ${new Date().toISOString()}

## Project Contents

| Folder | Description | Files |
|--------|-------------|-------|
| mprcontents/ | Model units (binary .mxunit files) | ${stats.mprcontents} |
| model-json/ | Human-readable JSON exports (for diffs) | ${stats['model-json'] || 'N/A'} |
| javascriptsource/ | JavaScript actions | ${stats.javascriptsource} |
| javasource/ | Java actions | ${stats.javasource} |
| themesource/ | Theme source files | ${stats.themesource} |
| widgets/ | Custom widgets | ${stats.widgets} |
| resources/ | Static resources | ${stats.resources} |

## Change Detection

The \`model-json/\` folder contains human-readable JSON representations of:
- **pages/** - Page definitions with titles, layouts, widget hierarchy
- **microflows/** - Microflow logic with actions, parameters, and flow structure
- **nanoflows/** - Nanoflow logic
- **domain-models/** - Entity definitions, attributes, associations, and validation rules
- **constants/** - App constants with types and default values
- **snippets/** - Reusable UI component definitions
- **enumerations/** - Enum definitions with values and captions
- **scheduled-events/** - Timer configurations and microflow bindings

These JSON files enable meaningful diffs when changes are made in Mendix Studio.

---
*Exported by LDV Bridge via Git clone + Model SDK from Mendix Team Server*
`,
      );

      // Generate a JSON summary for programmatic access
      const modelSummaryPath = path.join(exportDir, 'model-summary.json');
      fs.writeFileSync(
        modelSummaryPath,
        JSON.stringify(
          {
            appId: appLabel,
            projectId,
            branch: branchName,
            exportedAt: new Date().toISOString(),
            exportMethod: 'git-clone',
            stats,
          },
          null,
          2,
        ),
      );

      this.logger.log(`[GIT] Export complete: ${exportDir}`);
      this.logger.log(`[GIT] Stats: ${JSON.stringify(stats)}`);

      return exportDir;
    } catch (error) {
      this.logger.error(
        `[GIT] Export failed: ${(error as any).message}`,
        (error as any).stack,
      );
      // Clean up on failure
      try {
        fs.rmSync(exportDir, { recursive: true, force: true });
      } catch {}
      throw error;
    }
  }

  /**
   * Count files in key Mendix project folders
   */
  private countProjectFiles(dir: string): Record<string, number> {
    const stats: Record<string, number> = {
      mprcontents: 0,
      javascriptsource: 0,
      javasource: 0,
      themesource: 0,
      widgets: 0,
      resources: 0,
    };

    for (const folder of Object.keys(stats)) {
      const folderPath = path.join(dir, folder);
      if (fs.existsSync(folderPath)) {
        stats[folder] = this.countFilesRecursive(folderPath);
      }
    }

    return stats;
  }

  /**
   * Recursively count files in a directory
   */
  private countFilesRecursive(dir: string): number {
    let count = 0;
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          count += this.countFilesRecursive(path.join(dir, item.name));
        } else {
          count++;
        }
      }
    } catch {
      // Ignore errors
    }
    return count;
  }

  /**
   * Recursively remove all node_modules folders in a directory
   * This prevents long path issues on Windows and reduces export size
   */
  private removeNodeModulesRecursive(dir: string): void {
    try {
      const items = fs.readdirSync(dir, { withFileTypes: true });
      for (const item of items) {
        if (item.isDirectory()) {
          const itemPath = path.join(dir, item.name);
          if (item.name === 'node_modules') {
            // Remove the node_modules folder
            fs.rmSync(itemPath, { recursive: true, force: true });
          } else {
            // Continue searching in subdirectories
            this.removeNodeModulesRecursive(itemPath);
          }
        }
      }
    } catch {
      // Ignore errors
    }
  }

  /**
   * Add JSON model exports to the export directory for human-readable diffs
   * Uses the Model SDK to extract structured data from the binary model
   */
  private async addJsonModelExports(
    exportDir: string,
    projectId: string,
    pat: string,
    branchName: string,
  ): Promise<void> {
    this.logger.log(
      `[JSON] Starting JSON model export for projectId: ${projectId}, branch: ${branchName}`,
    );

    const jsonDir = path.join(exportDir, 'model-json');
    fs.mkdirSync(jsonDir, { recursive: true });
    this.logger.log(`[JSON] Created model-json directory at: ${jsonDir}`);

    const originalToken = process.env.MENDIX_TOKEN;

    try {
      // Configure the Platform SDK
      this.logger.log(`[JSON] Configuring Platform SDK...`);
      setPlatformConfig({ mendixToken: pat });
      process.env.MENDIX_TOKEN = pat;

      this.logger.log(`[JSON] Creating MendixPlatformClient...`);
      const client = new MendixPlatformClient();

      this.logger.log(`[JSON] Getting app for projectId: ${projectId}...`);
      const app = await client.getApp(projectId);

      this.logger.log(
        `[JSON] Creating working copy for JSON export (branch: ${branchName})...`,
      );

      // Add timeout to SDK calls (60 seconds) - these can hang indefinitely
      const SDK_TIMEOUT_MS = 60_000;

      const withTimeout = <T>(
        promise: Promise<T>,
        operation: string,
      ): Promise<T> => {
        return Promise.race([
          promise,
          new Promise<T>((_, reject) =>
            setTimeout(
              () =>
                reject(
                  new Error(
                    `Mendix SDK ${operation} timed out after ${SDK_TIMEOUT_MS / 1000} seconds`,
                  ),
                ),
              SDK_TIMEOUT_MS,
            ),
          ),
        ]);
      };

      const workingCopy = await withTimeout(
        app.createTemporaryWorkingCopy(branchName),
        'createTemporaryWorkingCopy',
      );

      this.logger.log(`[JSON] Opening model...`);
      const model = await withTimeout(workingCopy.openModel(), 'openModel');

      // Create subdirectories
      const pagesDir = path.join(jsonDir, 'pages');
      const microflowsDir = path.join(jsonDir, 'microflows');
      const nanoflowsDir = path.join(jsonDir, 'nanoflows');
      const domainModelsDir = path.join(jsonDir, 'domain-models');
      const constantsDir = path.join(jsonDir, 'constants');
      const snippetsDir = path.join(jsonDir, 'snippets');
      const enumerationsDir = path.join(jsonDir, 'enumerations');
      const scheduledEventsDir = path.join(jsonDir, 'scheduled-events');

      fs.mkdirSync(pagesDir, { recursive: true });
      fs.mkdirSync(microflowsDir, { recursive: true });
      fs.mkdirSync(nanoflowsDir, { recursive: true });
      fs.mkdirSync(domainModelsDir, { recursive: true });
      fs.mkdirSync(constantsDir, { recursive: true });
      fs.mkdirSync(snippetsDir, { recursive: true });
      fs.mkdirSync(enumerationsDir, { recursive: true });
      fs.mkdirSync(scheduledEventsDir, { recursive: true });

      const allModules = model.allModules();

      // Log all modules for debugging
      const moduleNames = allModules.map((m) => m.name);
      this.logger.log(
        `[JSON] Found ${moduleNames.length} modules: ${moduleNames.slice(0, 10).join(', ')}${moduleNames.length > 10 ? '...' : ''}`,
      );

      // Define system/marketplace modules to skip (these are Mendix platform or marketplace modules)
      // We only want to track changes to user-created modules
      const systemModules = new Set([
        // Core Mendix system modules
        'System',
        'MxModelReflection',
        'Administration',
        // Atlas UI framework
        'Atlas_Core',
        'Atlas_Web_Content',
        // Common marketplace modules
        'CommunityCommons',
        'Encryption',
        'ObjectHandling',
        'Email_Connector',
        'FeedbackModule',
        'WebActions',
        'NanoflowCommons',
        'Nanoflow_Commons',
        'DataGrid',
        'DataWidgets',
        'PopupMenu',
        'ExcelImporter',
        'MendixSSO',
        'SAML20',
        'DeepLink',
        'REST',
        // Add more marketplace modules as needed
      ]);

      // Count elements by module type for logging
      let userModuleCount = 0;
      let systemModuleCount = 0;

      let pagesExported = 0,
        microflowsExported = 0,
        nanoflowsExported = 0;
      let domainModelsExported = 0,
        constantsExported = 0,
        snippetsExported = 0;
      let enumerationsExported = 0,
        scheduledEventsExported = 0,
        skippedElements = 0;

      for (const module of allModules) {
        const moduleName = module.name;
        const isSystemModule =
          systemModules.has(moduleName) || moduleName.startsWith('Atlas_');

        if (isSystemModule) {
          systemModuleCount++;
          // Skip system modules to focus on user content (reduces noise)
          continue;
        }

        userModuleCount++;
        const safeModuleName = moduleName.replace(/[^a-zA-Z0-9_-]/g, '_');

        // Export domain model with detailed entity structure
        try {
          const domainModel = module.domainModel;
          if (domainModel) {
            await domainModel.load();
            this.logger.debug(
              `[JSON] Module "${moduleName}" has ${domainModel.entities?.length || 0} entities`,
            );

            const entities = domainModel.entities.map((entity) => ({
              name: entity.name,
              documentation: entity.documentation || undefined,
              generalization: (entity as any).generalization?.name || undefined,
              attributes: entity.attributes.map((attr) => ({
                name: attr.name,
                type: attr.type?.constructor?.name || 'Unknown',
                documentation: (attr as any).documentation || undefined,
                defaultValue: (attr as any).value?.defaultValue || undefined,
              })),
              // Enhanced: Add associations
              associations: this.extractAssociations(domainModel, entity.name),
              // Enhanced: Add validation rules
              validationRules:
                (entity as any).validationRules?.map((rule: any) => ({
                  attribute: rule.attribute?.name,
                  rule: rule.rule?.constructor?.name,
                  message: this.extractTextValue(rule.message),
                })) || [],
            }));

            // Export even if empty - this helps track that the module exists
            fs.writeFileSync(
              path.join(domainModelsDir, `${safeModuleName}.json`),
              JSON.stringify({ module: moduleName, entities }, null, 2),
            );
            domainModelsExported++;
          }
        } catch (err) {
          this.logger.debug(
            `[JSON] Failed to export domain model for "${moduleName}": ${err}`,
          );
          skippedElements++;
        }

        // Helper function to safely get module name
        const safeGetModuleName = (element: any): string | null => {
          try {
            return element.containerAsModule?.name || null;
          } catch {
            return null;
          }
        };

        // Export pages with detailed widget structure
        const pages = model
          .allPages()
          .filter((p) => safeGetModuleName(p) === moduleName);
        for (const pageInterface of pages) {
          try {
            const page = await pageInterface.load();
            const pageData = {
              name: page.name,
              title: page.title ? this.extractTextValue(page.title) : undefined,
              documentation: page.documentation || undefined,
              url: (page as any).url || undefined,
              layoutCall: page.layoutCall?.layout?.name || undefined,
              allowedRoles: page.allowedRoles?.map((r) => r.name) || [],
              // Enhanced: Extract widget structure for better diffs
              widgets: this.extractWidgetStructure(page),
            };

            fs.writeFileSync(
              path.join(pagesDir, `${safeModuleName}_${page.name}.json`),
              JSON.stringify(pageData, null, 2),
            );
            pagesExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export microflows with detailed action structure
        const microflows = model
          .allMicroflows()
          .filter((m) => safeGetModuleName(m) === moduleName);
        for (const mfInterface of microflows) {
          try {
            const microflow = await mfInterface.load();
            const mfData = {
              name: microflow.name,
              documentation: microflow.documentation || undefined,
              returnType:
                microflow.microflowReturnType?.constructor?.name || 'Unknown',
              allowedRoles:
                microflow.allowedModuleRoles?.map((r) => r.name) || [],
              // Enhanced: Extract action flow for better diffs
              actions: this.extractMicroflowActions(microflow),
              parameters: this.extractMicroflowParameters(microflow),
            };

            fs.writeFileSync(
              path.join(
                microflowsDir,
                `${safeModuleName}_${microflow.name}.json`,
              ),
              JSON.stringify(mfData, null, 2),
            );
            microflowsExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export nanoflows
        const nanoflows = model
          .allNanoflows()
          .filter((n) => safeGetModuleName(n) === moduleName);
        for (const nfInterface of nanoflows) {
          try {
            const nanoflow = await nfInterface.load();
            const nfData = {
              name: nanoflow.name,
              documentation: nanoflow.documentation || undefined,
              returnType:
                (nanoflow as any).nanoflowReturnType?.constructor?.name ||
                (nanoflow as any).microflowReturnType?.constructor?.name ||
                'Unknown',
              objectCount: nanoflow.objectCollection?.objects?.length || 0,
            };

            fs.writeFileSync(
              path.join(
                nanoflowsDir,
                `${safeModuleName}_${nanoflow.name}.json`,
              ),
              JSON.stringify(nfData, null, 2),
            );
            nanoflowsExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export constants
        const constants = model
          .allConstants()
          .filter((c) => safeGetModuleName(c) === moduleName);
        for (const constInterface of constants) {
          try {
            const constant = await constInterface.load();
            const constData = {
              name: constant.name,
              documentation: constant.documentation || undefined,
              type: constant.type?.constructor?.name || 'Unknown',
              defaultValue: constant.defaultValue || undefined,
            };

            fs.writeFileSync(
              path.join(
                constantsDir,
                `${safeModuleName}_${constant.name}.json`,
              ),
              JSON.stringify(constData, null, 2),
            );
            constantsExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export snippets
        const snippets = model
          .allSnippets()
          .filter((s) => safeGetModuleName(s) === moduleName);
        for (const snippetInterface of snippets) {
          try {
            const snippet = await snippetInterface.load();
            const snippetData = {
              name: snippet.name,
              documentation: snippet.documentation || undefined,
              widgets: this.extractWidgetStructure(snippet),
            };

            fs.writeFileSync(
              path.join(snippetsDir, `${safeModuleName}_${snippet.name}.json`),
              JSON.stringify(snippetData, null, 2),
            );
            snippetsExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export enumerations
        const enumerations = model
          .allEnumerations()
          .filter((e) => safeGetModuleName(e) === moduleName);
        for (const enumInterface of enumerations) {
          try {
            const enumeration = await enumInterface.load();
            const enumData = {
              name: enumeration.name,
              documentation: enumeration.documentation || undefined,
              values:
                enumeration.values?.map((v: any) => ({
                  name: v.name,
                  caption: this.extractTextValue(v.caption),
                  image: v.image?.name,
                })) || [],
            };

            fs.writeFileSync(
              path.join(
                enumerationsDir,
                `${safeModuleName}_${enumeration.name}.json`,
              ),
              JSON.stringify(enumData, null, 2),
            );
            enumerationsExported++;
          } catch {
            skippedElements++;
          }
        }

        // Export scheduled events
        const scheduledEvents = model
          .allScheduledEvents()
          .filter((se) => safeGetModuleName(se) === moduleName);
        for (const seInterface of scheduledEvents) {
          try {
            const scheduledEvent = await seInterface.load();
            const seData = {
              name: scheduledEvent.name,
              documentation: scheduledEvent.documentation || undefined,
              enabled: (scheduledEvent as any).enabled,
              startDateTime: (scheduledEvent as any).startDateTime,
              intervalType: (scheduledEvent as any).intervalType?.name,
              interval: (scheduledEvent as any).interval,
              microflow: (scheduledEvent as any).microflow?.name,
            };

            fs.writeFileSync(
              path.join(
                scheduledEventsDir,
                `${safeModuleName}_${scheduledEvent.name}.json`,
              ),
              JSON.stringify(seData, null, 2),
            );
            scheduledEventsExported++;
          } catch {
            skippedElements++;
          }
        }
      }

      // Write summary
      const summary = {
        exportedAt: new Date().toISOString(),
        projectId,
        branch: branchName,
        modules: {
          total: allModules.length,
          user: userModuleCount,
          system: systemModuleCount,
          userModuleNames: allModules
            .filter((m) => {
              const name = m.name;
              return !systemModules.has(name) && !name.startsWith('Atlas_');
            })
            .map((m) => m.name),
          systemModuleNames: allModules
            .filter((m) => {
              const name = m.name;
              return systemModules.has(name) || name.startsWith('Atlas_');
            })
            .map((m) => m.name),
        },
        counts: {
          pages: pagesExported,
          microflows: microflowsExported,
          nanoflows: nanoflowsExported,
          domainModels: domainModelsExported,
          constants: constantsExported,
          snippets: snippetsExported,
          enumerations: enumerationsExported,
          scheduledEvents: scheduledEventsExported,
        },
        skippedElements,
      };

      fs.writeFileSync(
        path.join(jsonDir, 'summary.json'),
        JSON.stringify(summary, null, 2),
      );

      this.logger.log(
        `[JSON] Processed ${userModuleCount} user modules (skipped ${systemModuleCount} system modules)`,
      );
      this.logger.log(
        `[JSON] Exported: ${pagesExported} pages, ${microflowsExported} microflows, ` +
          `${nanoflowsExported} nanoflows, ${domainModelsExported} domain models, ` +
          `${constantsExported} constants, ${snippetsExported} snippets, ` +
          `${enumerationsExported} enums, ${scheduledEventsExported} scheduled events ` +
          `(${skippedElements} skipped)`,
      );
    } finally {
      // Restore original token
      if (originalToken !== undefined) {
        process.env.MENDIX_TOKEN = originalToken;
      } else {
        delete process.env.MENDIX_TOKEN;
      }
    }
  }

  /**
   * Extract text value from Mendix Text object
   */
  private extractTextValue(text: any): string | undefined {
    try {
      if (!text) return undefined;

      // Try to get the first translation
      if (text.translations && text.translations.length > 0) {
        return text.translations[0].text;
      }

      // Try items array (for ClientTemplate)
      if (text.items && text.items.length > 0) {
        const firstItem = text.items[0];
        if (firstItem.translations && firstItem.translations.length > 0) {
          return firstItem.translations[0].text;
        }
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Extract widget structure from a page for detailed diffs
   * Uses the Mendix SDK traverse() method to walk all structures
   */
  private extractWidgetStructure(page: any): any[] {
    try {
      const widgets: any[] = [];
      const widgetTypes = new Set<string>();

      // Define actual visual widget types we want to capture
      // These are the real UI components, not SDK metadata structures
      const visualWidgetTypes = new Set([
        // Layout widgets
        'Pages$Container',
        'Pages$LayoutGrid',
        'Pages$LayoutGridRow',
        'Pages$LayoutGridColumn',
        'Pages$Table',
        'Pages$TableRow',
        'Pages$TableCell',
        'Pages$TabContainer',
        'Pages$TabPage',
        'Pages$ScrollContainer',
        'Pages$NavigationList',
        'Pages$NavigationListItem',
        'Pages$GroupBox',
        'Pages$Placeholder',
        // Data widgets
        'Pages$DataView',
        'Pages$ListView',
        'Pages$TemplateGrid',
        'Pages$DataGrid',
        'Pages$DataGrid2',
        'Pages$ReferenceSetSelector',
        // Input widgets
        'Pages$TextBox',
        'Pages$TextArea',
        'Pages$DropDown',
        'Pages$RadioButtons',
        'Pages$CheckBox',
        'Pages$DatePicker',
        'Pages$ReferenceSelector',
        'Pages$InputReferenceSetSelector',
        'Pages$FileManager',
        'Pages$ImageUploader',
        // Display widgets
        'Pages$Text',
        'Pages$Title',
        'Pages$Label',
        'Pages$DynamicText',
        'Pages$StaticImageViewer',
        'Pages$DynamicImage',
        'Pages$ImageViewer',
        // Action widgets
        'Pages$Button',
        'Pages$ActionButton',
        'Pages$DropDownButton',
        'Pages$LinkButton',
        'Pages$SignOutButton',
        // Other
        'Pages$Snippet',
        'Pages$SnippetCall',
        'Pages$Header',
        'Pages$SidebarToggleButton',
        'Pages$MenuBar',
        'Pages$SimpleMenuBar',
        'Pages$NavigationTree',
        'Pages$MenuWidget',
        // Custom widgets (marketplace/custom)
        'CustomWidgets$CustomWidget',
        'CustomWidgets$CustomWidgetType',
      ]);

      // Use the SDK's traverse method to walk all page structures
      page.traverse((structure: any) => {
        const typeName =
          structure.structureTypeName || structure.constructor?.name;

        if (!typeName) return;

        // Track all types for debugging
        widgetTypes.add(typeName);

        // Only capture actual visual widget types
        if (visualWidgetTypes.has(typeName)) {
          const widgetData = this.extractWidgetFromStructure(
            structure,
            typeName,
          );
          if (widgetData) {
            widgets.push(widgetData);
          }
        }
      });

      this.logger.debug(
        `[Widget] Page "${page.name}" - found ${widgets.length} widgets. All types seen: ${Array.from(widgetTypes).join(', ')}`,
      );

      return widgets;
    } catch (err) {
      this.logger.warn(`[Widget] Error extracting widgets from page: ${err}`);
      return [];
    }
  }

  /**
   * Extract data from a widget structure found via traverse
   */
  private extractWidgetFromStructure(structure: any, typeName: string): any {
    // Get display type name
    let displayType = typeName
      .replace('Pages$', '')
      .replace('CustomWidgets$', '');

    const result: any = {
      type: displayType,
    };

    // Helper to safely get a property value
    const safeGet = (obj: any, prop: string): any => {
      try {
        return obj?.[prop];
      } catch {
        return undefined;
      }
    };

    // Helper to safely get nested property
    const safeGetNested = (obj: any, ...props: string[]): any => {
      try {
        let value = obj;
        for (const prop of props) {
          value = value?.[prop];
          if (value === undefined) return undefined;
        }
        return value;
      } catch {
        return undefined;
      }
    };

    // For custom widgets, try to get the actual widget type
    if (typeName.includes('CustomWidget')) {
      const widgetType =
        safeGetNested(structure, 'type', 'widgetId') ||
        safeGetNested(structure, 'type', 'name') ||
        safeGet(structure, 'widgetId') ||
        safeGetNested(structure, 'type', 'qualifiedName');

      if (widgetType) {
        const parts = String(widgetType).split('.');
        displayType = parts[parts.length - 1] || displayType;
        result.type = displayType;
        result.widgetId = widgetType;
      }
    }

    // Add name if available - key for identification
    const name = safeGet(structure, 'name');
    if (name) result.name = name;

    // Add internal ID if available
    const id = safeGet(structure, 'id');
    if (id) result.id = id;

    // Add class/style info (common user changes)
    const cssClass = safeGet(structure, 'class');
    if (cssClass) result.class = cssClass;

    const style = safeGet(structure, 'style');
    if (style) result.style = style;

    // Extract specific properties based on widget type
    this.extractTypeSpecificProperties(
      structure,
      displayType,
      result,
      safeGet,
      safeGetNested,
    );

    return result;
  }

  /**
   * Extract type-specific properties from widgets
   */
  private extractTypeSpecificProperties(
    structure: any,
    displayType: string,
    result: any,
    safeGet: (obj: any, prop: string) => any,
    safeGetNested: (obj: any, ...props: string[]) => any,
  ): void {
    // Text/Label widgets
    if (
      displayType.includes('Text') ||
      displayType.includes('Title') ||
      displayType.includes('Label')
    ) {
      const content =
        safeGet(structure, 'content') ||
        safeGet(structure, 'caption') ||
        safeGet(structure, 'text');
      const text = this.extractTextValueSafe(content);
      if (text) result.content = text;
    }

    // Button widgets
    if (displayType.includes('Button')) {
      const caption = this.extractTextValueSafe(safeGet(structure, 'caption'));
      if (caption) result.caption = caption;

      const actionType = safeGetNested(
        structure,
        'action',
        'constructor',
        'name',
      );
      if (actionType) result.action = actionType;

      const buttonStyle = safeGet(structure, 'buttonStyle');
      if (buttonStyle) result.buttonStyle = String(buttonStyle);

      const renderType = safeGet(structure, 'renderType');
      if (renderType) result.renderType = String(renderType);
    }

    // Data widgets (DataView, ListView, etc.)
    if (
      displayType.includes('DataView') ||
      displayType.includes('ListView') ||
      displayType.includes('TemplateGrid')
    ) {
      const dataSourceType = safeGetNested(
        structure,
        'dataSource',
        'constructor',
        'name',
      );
      if (dataSourceType) result.dataSource = dataSourceType;

      const entity = safeGetNested(structure, 'entityRef', 'entity', 'name');
      if (entity) result.entity = entity;
    }

    // Input widgets (TextBox, TextArea, etc.)
    if (
      displayType.includes('TextBox') ||
      displayType.includes('Input') ||
      displayType.includes('TextArea')
    ) {
      const attribute = safeGetNested(
        structure,
        'attributeRef',
        'attribute',
        'name',
      );
      if (attribute) result.attribute = attribute;

      const label = this.extractTextValueSafe(safeGet(structure, 'label'));
      if (label) result.label = label;

      const placeholder = this.extractTextValueSafe(
        safeGet(structure, 'placeholder'),
      );
      if (placeholder) result.placeholder = placeholder;
    }

    // Image widgets
    if (displayType.includes('Image')) {
      const imageSourceType = safeGetNested(
        structure,
        'imageSource',
        'constructor',
        'name',
      );
      if (imageSourceType) result.imageSource = imageSourceType;

      const defaultImage = safeGetNested(structure, 'defaultImage', 'name');
      if (defaultImage) result.defaultImage = defaultImage;
    }

    // Selector widgets (DropDown, ReferenceSelector)
    if (
      displayType.includes('DropDown') ||
      displayType.includes('ReferenceSelector')
    ) {
      const attribute = safeGetNested(
        structure,
        'attributeRef',
        'attribute',
        'name',
      );
      if (attribute) result.attribute = attribute;

      const selectorSourceType = safeGetNested(
        structure,
        'selectorSource',
        'constructor',
        'name',
      );
      if (selectorSourceType) result.selectorSource = selectorSourceType;
    }

    // Layout widgets (Container, LayoutGrid, etc.)
    if (
      displayType.includes('Container') ||
      displayType.includes('LayoutGrid')
    ) {
      const conditionalVisibility = safeGet(structure, 'conditionalVisibility');
      if (conditionalVisibility) result.hasConditionalVisibility = true;
    }

    // Tab containers
    if (
      displayType.includes('TabContainer') ||
      displayType.includes('TabPage')
    ) {
      const caption = safeGet(structure, 'caption');
      if (caption) {
        const captionText = this.extractTextValueSafe(caption);
        result.caption = captionText || String(caption);
      }
    }

    // GroupBox
    if (displayType.includes('GroupBox')) {
      const caption = this.extractTextValueSafe(safeGet(structure, 'caption'));
      if (caption) result.caption = caption;

      const collapsible = safeGet(structure, 'collapsible');
      if (collapsible !== undefined) result.collapsible = collapsible;
    }
  }

  /**
   * Safe version of extractTextValue that doesn't throw
   */
  private extractTextValueSafe(template: any): string | null {
    if (!template) return null;
    try {
      // Handle ClientTemplate, TextTemplate, etc.
      if (template.template) {
        return template.template;
      }
      if (template.text) {
        return template.text;
      }
      // If it has translations, get the first one
      if (template.translations?.length > 0) {
        return template.translations[0].text;
      }
      // Direct string
      if (typeof template === 'string') {
        return template;
      }
    } catch {
      // Ignore
    }
    return null;
  }

  /**
   * Extract microflow actions for detailed diffs
   */
  private extractMicroflowActions(microflow: any): any[] {
    try {
      const actions: any[] = [];
      const objects = microflow.objectCollection?.objects || [];

      for (const obj of objects) {
        try {
          const actionType = obj.constructor?.name || 'Unknown';
          const action: any = {
            type: actionType,
          };

          // Extract details based on action type
          if (actionType.includes('ActionActivity')) {
            action.actionType = obj.action?.constructor?.name;
            // For microflow calls
            if (obj.action?.microflowCall) {
              action.microflowCalled = obj.action.microflowCall.microflow?.name;
            }
            // For change object
            if (
              actionType.includes('ChangeObject') ||
              obj.action?.constructor?.name?.includes('Change')
            ) {
              action.entity = (obj.action as any)?.changeVariableName;
            }
            // For create object
            if (
              actionType.includes('CreateObject') ||
              obj.action?.constructor?.name?.includes('Create')
            ) {
              action.entity = (obj.action as any)?.entity?.name;
            }
            // For retrieve
            if (obj.action?.constructor?.name?.includes('Retrieve')) {
              action.entity = (obj.action as any)?.entity?.name;
              action.xpathConstraint = (obj.action as any)?.xpathConstraint;
            }
          } else if (
            actionType.includes('ExclusiveSplit') ||
            actionType.includes('Decision')
          ) {
            action.expression =
              obj.splitCondition?.expression || obj.expression;
          } else if (
            actionType.includes('LoopedActivity') ||
            actionType.includes('Loop')
          ) {
            action.iteratedListVariableName = obj.iteratedListVariableName;
          } else if (actionType.includes('EndEvent')) {
            action.returnValue = obj.returnValue;
          }

          // Add caption/documentation if available
          if (obj.caption) {
            action.caption = this.extractTextValue(obj.caption) || obj.caption;
          }
          if (obj.documentation) {
            action.documentation = obj.documentation;
          }

          actions.push(action);
        } catch {
          actions.push({ type: 'Unknown', error: 'Failed to extract' });
        }
      }

      return actions;
    } catch {
      return [];
    }
  }

  /**
   * Extract microflow parameters
   */
  private extractMicroflowParameters(microflow: any): any[] {
    try {
      const parameters: any[] = [];
      const params =
        microflow.parameters ||
        microflow.objectCollection?.objects?.filter((o: any) =>
          o.constructor?.name?.includes('Parameter'),
        ) ||
        [];

      for (const param of params) {
        try {
          parameters.push({
            name: param.name,
            type:
              param.variableType?.constructor?.name ||
              param.type?.constructor?.name ||
              'Unknown',
            entity:
              (param as any).entity?.name ||
              (param as any).variableType?.entity?.name,
          });
        } catch {
          // Skip problematic parameters
        }
      }

      return parameters;
    } catch {
      return [];
    }
  }

  /**
   * Extract associations from domain model
   */
  private extractAssociations(domainModel: any, entityName: string): any[] {
    try {
      const associations: any[] = [];
      const allAssociations = domainModel.associations || [];

      for (const assoc of allAssociations) {
        try {
          // Check if this association involves the entity
          const parentName = assoc.parent?.name;
          const childName = assoc.child?.name;

          if (parentName === entityName || childName === entityName) {
            associations.push({
              name: assoc.name,
              type: assoc.type?.name || String(assoc.type),
              parent: parentName,
              child: childName,
              parentDeleteBehavior: assoc.parentDeleteBehavior?.name,
              childDeleteBehavior: assoc.childDeleteBehavior?.name,
            });
          }
        } catch {
          // Skip problematic associations
        }
      }

      return associations;
    } catch {
      return [];
    }
  }
}
