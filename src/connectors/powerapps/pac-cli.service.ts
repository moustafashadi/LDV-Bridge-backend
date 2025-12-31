import { Injectable, Logger, BadRequestException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as path from 'path';
import * as fs from 'fs/promises';
import * as os from 'os';

const execAsync = promisify(exec);

/**
 * Power Platform CLI (PAC) Service
 * Wraps the PAC CLI for canvas app operations that aren't available via REST API
 *
 * Required: pac CLI must be installed on the server
 * Install via: npm install -g @microsoft/power-platform-cli
 * Or via dotnet: dotnet tool install --global Microsoft.PowerApps.CLI.Tool
 */
@Injectable()
export class PacCliService {
  private readonly logger = new Logger(PacCliService.name);
  private readonly tempDir: string;
  private pacPath: string | null = null; // Resolved path to pac executable

  constructor(private config: ConfigService) {
    // Use user's home directory to avoid Windows 8.3 short path format issues
    // On Windows, os.tmpdir() may return short paths like DELLI7~1 which causes issues
    this.tempDir = path.join(os.homedir(), '.ldv-bridge', 'pac-temp');
  }

  /**
   * Get the path to the PAC CLI executable
   * Searches common installation locations
   */
  private async getPacPath(): Promise<string> {
    if (this.pacPath) {
      return this.pacPath;
    }

    // Common PAC CLI installation locations
    const possiblePaths = [
      'pac', // In PATH
      path.join(os.homedir(), '.dotnet', 'tools', 'pac.exe'), // dotnet global tool (Windows)
      path.join(os.homedir(), '.dotnet', 'tools', 'pac'), // dotnet global tool (Linux/Mac)
      'C:\\Program Files\\Microsoft Power Platform CLI\\pac.exe', // Windows installer
      '/usr/local/bin/pac', // Linux/Mac global
    ];

    this.logger.debug(
      `Searching for PAC CLI in: ${JSON.stringify(possiblePaths)}`,
    );
    this.logger.debug(`Home directory: ${os.homedir()}`);

    const isWindows = os.platform() === 'win32';

    for (const pacPath of possiblePaths) {
      try {
        this.logger.debug(`Trying PAC CLI path: ${pacPath}`);
        // On Windows, use PowerShell with & operator and escaped double quotes to handle paths with spaces
        const command = isWindows
          ? `powershell -Command "& \`"${pacPath}\`" --version"`
          : `"${pacPath}" --version`;
        const { stdout } = await execAsync(command, { timeout: 10000 });
        this.pacPath = pacPath;
        this.logger.log(
          `Found PAC CLI at: ${pacPath} (version: ${stdout.trim().substring(0, 50)})`,
        );
        return pacPath;
      } catch (error) {
        this.logger.debug(
          `PAC CLI not found at ${pacPath}: ${error.message?.substring(0, 100)}`,
        );
      }
    }

    throw new BadRequestException(
      'PAC CLI not found. Install via: dotnet tool install --global Microsoft.PowerApps.CLI.Tool',
    );
  }

  /**
   * Execute a PAC CLI command
   * Uses PowerShell on Windows to properly handle paths with spaces
   * Note: PAC CLI writes output to stderr, so we redirect stderr to stdout (2>&1)
   */
  private async execPac(
    args: string,
    options?: { timeout?: number },
  ): Promise<{ stdout: string; stderr: string }> {
    const pacPath = await this.getPacPath();
    const isWindows = os.platform() === 'win32';
    // On Windows, use PowerShell with & operator and escaped double quotes to handle paths with spaces
    // PAC CLI writes output to stderr, so we need 2>&1 to redirect it to stdout for capture
    const command = isWindows
      ? `powershell -Command "& '${pacPath}' ${args} 2>&1"`
      : `"${pacPath}" ${args} 2>&1`;
    this.logger.debug(`Executing: ${command}`);
    return execAsync(command, { timeout: options?.timeout || 60000 });
  }

  /**
   * Check if PAC CLI is available
   */
  async isAvailable(): Promise<boolean> {
    try {
      await this.getPacPath();
      return true;
    } catch (error) {
      this.logger.warn(
        'PAC CLI not found. Install via: dotnet tool install --global Microsoft.PowerApps.CLI.Tool',
      );
      return false;
    }
  }

  /**
   * Get PAC CLI version
   */
  async getVersion(): Promise<string> {
    try {
      const { stdout } = await this.execPac('--version');
      return stdout.trim();
    } catch (error) {
      throw new BadRequestException('PAC CLI not installed');
    }
  }

  /**
   * Create or update authentication profile using refresh token
   * PAC CLI supports authentication via access token
   */
  async createAuthProfile(
    profileName: string,
    environmentUrl: string,
    accessToken: string,
  ): Promise<void> {
    try {
      this.logger.log(`Creating PAC auth profile: ${profileName}`);

      // Clear existing profile if exists
      try {
        await this.execPac(`auth delete --name '${profileName}'`);
      } catch {
        // Profile might not exist, ignore error
      }

      // Create new profile with access token
      // Note: PAC CLI supports --cloud and various auth methods
      const { stdout, stderr } = await this.execPac(
        `auth create --name '${profileName}' --environment '${environmentUrl}' --kind Admin`,
        { timeout: 60000 },
      );

      if (stderr && !stderr.includes('Successfully')) {
        this.logger.warn(`PAC auth warning: ${stderr}`);
      }

      this.logger.log(`PAC auth profile "${profileName}" created`);
    } catch (error) {
      this.logger.error(`Failed to create PAC auth profile: ${error.message}`);
      throw new BadRequestException(
        `Failed to authenticate with PAC CLI: ${error.message}`,
      );
    }
  }

  /**
   * Select an authentication profile
   */
  async selectAuthProfile(profileName: string): Promise<void> {
    try {
      await this.execPac(`auth select --name '${profileName}'`);
      this.logger.log(`Selected PAC auth profile: ${profileName}`);
    } catch (error) {
      throw new BadRequestException(
        `Failed to select auth profile: ${error.message}`,
      );
    }
  }

  /**
   * Download a canvas app as .msapp file
   * @param appName The name or GUID of the app
   * @param environmentId The environment ID
   * @param outputPath Where to save the .msapp file
   */
  async downloadCanvasApp(
    appName: string,
    environmentId: string,
    outputPath: string,
  ): Promise<string> {
    try {
      this.logger.log(`Downloading canvas app: ${appName}`);

      // Ensure output directory exists
      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      // Use pac canvas download
      const { stdout, stderr } = await this.execPac(
        `canvas download --name "${appName}" --environment "${environmentId}" --file-name "${outputPath}"`,
        { timeout: 300000 }, // 5 minute timeout
      );

      if (stderr && !stderr.includes('Downloaded')) {
        this.logger.warn(`PAC canvas download warning: ${stderr}`);
      }

      this.logger.log(`Canvas app downloaded to: ${outputPath}`);
      return outputPath;
    } catch (error) {
      this.logger.error(`Failed to download canvas app: ${error.message}`);
      throw new BadRequestException(
        `Failed to download canvas app: ${error.message}`,
      );
    }
  }

  /**
   * Upload/create a canvas app from .msapp file
   * @param msappPath Path to the .msapp file
   * @param appName Display name for the app
   * @param environmentId Target environment ID
   */
  async uploadCanvasApp(
    msappPath: string,
    appName: string,
    environmentId: string,
  ): Promise<{ appId: string; displayName: string }> {
    try {
      this.logger.log(
        `Uploading canvas app: ${appName} to environment ${environmentId}`,
      );

      // Verify file exists
      await fs.access(msappPath);

      // Use pac canvas upload (or pac canvas create)
      // Note: The exact command may vary by PAC CLI version
      const { stdout, stderr } = await this.execPac(
        `canvas upload --msapp "${msappPath}" --display-name "${appName}" --environment "${environmentId}"`,
        { timeout: 300000 }, // 5 minute timeout
      );

      // Parse output for app ID
      // Output format varies, typically includes the new app ID
      const appIdMatch =
        stdout.match(/App ID:\s*(\S+)/i) ||
        stdout.match(/Created app:\s*(\S+)/i) ||
        stdout.match(/([a-f0-9-]{36})/i);

      const appId = appIdMatch ? appIdMatch[1] : 'unknown';

      if (stderr && !stderr.includes('Successfully')) {
        this.logger.warn(`PAC canvas upload warning: ${stderr}`);
      }

      this.logger.log(`Canvas app uploaded successfully: ${appId}`);

      return {
        appId,
        displayName: appName,
      };
    } catch (error) {
      this.logger.error(`Failed to upload canvas app: ${error.message}`);
      throw new BadRequestException(
        `Failed to upload canvas app: ${error.message}`,
      );
    }
  }

  /**
   * Unpack an .msapp file to source files
   * @param msappPath Path to the .msapp file
   * @param outputDir Directory to extract source files
   */
  async unpackMsapp(msappPath: string, outputDir: string): Promise<string> {
    try {
      this.logger.log(`Unpacking .msapp: ${msappPath}`);

      await fs.mkdir(outputDir, { recursive: true });

      const { stdout, stderr } = await this.execPac(
        `canvas unpack --msapp "${msappPath}" --sources "${outputDir}"`,
        { timeout: 120000 },
      );

      if (stderr) {
        this.logger.warn(`PAC unpack warning: ${stderr}`);
      }

      this.logger.log(`Unpacked to: ${outputDir}`);
      return outputDir;
    } catch (error) {
      this.logger.error(`Failed to unpack .msapp: ${error.message}`);
      throw new BadRequestException(
        `Failed to unpack .msapp: ${error.message}`,
      );
    }
  }

  /**
   * Pack source files into an .msapp file
   * @param sourceDir Directory containing source files
   * @param outputPath Path for the output .msapp file
   */
  async packMsapp(sourceDir: string, outputPath: string): Promise<string> {
    try {
      this.logger.log(`Packing source files from: ${sourceDir}`);

      await fs.mkdir(path.dirname(outputPath), { recursive: true });

      const { stdout, stderr } = await this.execPac(
        `canvas pack --msapp "${outputPath}" --sources "${sourceDir}"`,
        { timeout: 120000 },
      );

      if (stderr) {
        this.logger.warn(`PAC pack warning: ${stderr}`);
      }

      this.logger.log(`Packed to: ${outputPath}`);
      return outputPath;
    } catch (error) {
      this.logger.error(`Failed to pack .msapp: ${error.message}`);
      throw new BadRequestException(`Failed to pack .msapp: ${error.message}`);
    }
  }

  /**
   * Copy a canvas app to a new environment using solution-based approach
   * This is the proper way to copy canvas apps between environments
   *
   * Workflow:
   * 1. Create a temporary unmanaged solution in source environment
   * 2. Add the canvas app to the solution
   * 3. Export the solution as .zip
   * 4. Import the solution to target environment
   * 5. Clean up the temp solution in source
   */
  async copyCanvasApp(
    sourceAppId: string,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
    newDisplayName: string,
  ): Promise<{
    appId: string;
    name: string;
    displayName: string;
    studioUrl?: string;
  }> {
    const workDir = path.join(this.tempDir, `copy-${Date.now()}`);
    const solutionName = `LDVBridge_Temp_${Date.now()}`;
    const solutionZipPath = path.join(workDir, `${solutionName}.zip`);

    try {
      this.logger.log(
        `Copying canvas app ${sourceAppId} to environment ${targetEnvironmentId} via solution`,
      );

      // Create work directory
      await fs.mkdir(workDir, { recursive: true });

      // Step 1: Select source environment
      this.logger.log(
        `Step 1: Selecting source environment ${sourceEnvironmentId}...`,
      );
      await this.selectEnvironment(sourceEnvironmentId);

      // Step 2: Create temporary solution
      this.logger.log(`Step 2: Creating temporary solution ${solutionName}...`);
      await this.createSolution(
        solutionName,
        'LDV Bridge',
        'Temporary solution for app copy',
      );

      // Step 3: Add canvas app to solution
      this.logger.log(
        `Step 3: Adding canvas app ${sourceAppId} to solution...`,
      );
      await this.addComponentToSolution(solutionName, 'CanvasApp', sourceAppId);

      // Step 4: Export solution
      this.logger.log(`Step 4: Exporting solution to ${solutionZipPath}...`);
      await this.exportSolution(solutionName, solutionZipPath);

      // Verify export
      const stats = await fs.stat(solutionZipPath);
      this.logger.log(`Exported solution size: ${stats.size} bytes`);

      // Step 5: Select target environment
      this.logger.log(
        `Step 5: Selecting target environment ${targetEnvironmentId}...`,
      );
      await this.selectEnvironment(targetEnvironmentId);

      // Step 6: Import solution to target
      this.logger.log(`Step 6: Importing solution to target environment...`);
      await this.importSolution(solutionZipPath);

      // Step 7: Get the imported app ID from the solution
      this.logger.log(`Step 7: Looking up imported app...`);
      const importedAppId = await this.getAppFromSolution(
        solutionName,
        newDisplayName,
      );

      // Step 8: Clean up - delete temp solution from source
      this.logger.log(`Step 8: Cleaning up temp solution from source...`);
      try {
        await this.selectEnvironment(sourceEnvironmentId);
        await this.deleteSolution(solutionName);
      } catch (cleanupError) {
        this.logger.warn(
          `Failed to cleanup source solution: ${cleanupError.message}`,
        );
      }

      // Build studio URL
      const studioUrl = `https://make.powerapps.com/e/${targetEnvironmentId}/canvas?action=edit&app-id=/providers/Microsoft.PowerApps/apps/${importedAppId}`;

      this.logger.log(`Successfully copied canvas app to ${importedAppId}`);

      return {
        appId: importedAppId,
        name: importedAppId,
        displayName: newDisplayName,
        studioUrl,
      };
    } catch (error) {
      this.logger.error(
        `Failed to copy canvas app via solution: ${error.message}`,
      );

      // Attempt cleanup on failure
      try {
        await this.selectEnvironment(sourceEnvironmentId);
        await this.deleteSolution(solutionName);
      } catch {
        // Ignore cleanup errors
      }

      throw new BadRequestException(
        `Failed to copy canvas app: ${error.message}`,
      );
    } finally {
      // Cleanup temp files
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Export an existing solution from source environment and import to target
   * This method assumes the solution already exists in Dataverse (created via Web API)
   */
  async exportAndImportSolution(
    solutionName: string,
    sourceEnvironmentId: string,
    targetEnvironmentId: string,
    newDisplayName: string,
  ): Promise<{
    appId: string;
    name: string;
    displayName: string;
    studioUrl?: string;
  }> {
    const workDir = path.join(this.tempDir, `export-${Date.now()}`);
    const solutionZipPath = path.join(workDir, `${solutionName}.zip`);

    try {
      this.logger.log(
        `Exporting solution ${solutionName} from ${sourceEnvironmentId} and importing to ${targetEnvironmentId}`,
      );

      // Create work directory
      await fs.mkdir(workDir, { recursive: true });

      // Step 1: Select source environment
      this.logger.log(
        `Step 1: Selecting source environment ${sourceEnvironmentId}...`,
      );
      await this.selectEnvironment(sourceEnvironmentId);

      // Step 2: Export solution
      this.logger.log(`Step 2: Exporting solution to ${solutionZipPath}...`);
      await this.exportSolution(solutionName, solutionZipPath);

      // Verify export
      const stats = await fs.stat(solutionZipPath);
      this.logger.log(`Exported solution size: ${stats.size} bytes`);

      // Step 3: Select target environment
      this.logger.log(
        `Step 3: Selecting target environment ${targetEnvironmentId}...`,
      );
      await this.selectEnvironment(targetEnvironmentId);

      // Step 4: Import solution to target
      this.logger.log(`Step 4: Importing solution to target environment...`);
      await this.importSolution(solutionZipPath);

      // Step 5: Get the imported app ID from the solution
      this.logger.log(`Step 5: Looking up imported app...`);
      const importedAppId = await this.getAppFromSolution(
        solutionName,
        newDisplayName,
      );

      // Build studio URL
      const studioUrl = `https://make.powerapps.com/e/${targetEnvironmentId}/canvas?action=edit&app-id=/providers/Microsoft.PowerApps/apps/${importedAppId}`;

      this.logger.log(
        `Successfully exported and imported solution, app ID: ${importedAppId}`,
      );

      return {
        appId: importedAppId,
        name: importedAppId,
        displayName: newDisplayName,
        studioUrl,
      };
    } catch (error) {
      this.logger.error(`Failed to export/import solution: ${error.message}`);
      throw new BadRequestException(
        `Failed to export/import solution: ${error.message}`,
      );
    } finally {
      // Cleanup temp files
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }
    }
  }

  /**
   * Select/connect to a Power Platform environment
   */
  async selectEnvironment(environmentId: string): Promise<void> {
    try {
      // PAC CLI uses environment URL or ID
      const envUrl = `https://${environmentId}.crm.dynamics.com`;

      const { stdout, stderr } = await this.execPac(
        `org select --environment '${environmentId}'`,
        { timeout: 30000 },
      );

      this.logger.log(`Selected environment: ${environmentId}`);
    } catch (error) {
      // Try with full environment URL format
      try {
        await this.execPac(`env select --environment '${environmentId}'`, {
          timeout: 30000,
        });
        this.logger.log(
          `Selected environment via env select: ${environmentId}`,
        );
      } catch (e2) {
        this.logger.error(`Failed to select environment: ${error.message}`);
        throw new BadRequestException(
          `Failed to select environment: ${error.message}`,
        );
      }
    }
  }

  /**
   * Create a new unmanaged solution in Dataverse
   * Uses the PAC CLI to create the solution directly in the connected environment
   */
  async createSolution(
    solutionName: string,
    publisherName: string,
    description: string,
  ): Promise<void> {
    try {
      // First, we need to ensure a publisher exists or use the default
      // The solution will be created using pac solution create-settings and then online-version
      // However, the simplest approach is to use pac solution init followed by pac solution push

      // Alternative approach: Create solution directly via PAC CLI
      // The `pac solution add-solution-component` command actually creates the solution if it doesn't exist
      // when using the correct flags

      // Let's check if the solution already exists first
      try {
        const { stdout: listOutput } = await this.execPac('solution list', {
          timeout: 30000,
        });
        if (listOutput.includes(solutionName)) {
          this.logger.log(
            `Solution ${solutionName} already exists, reusing it`,
          );
          return;
        }
      } catch {
        // Ignore list errors
      }

      // Create the solution using pac solution create-settings which creates it in Dataverse
      // First create a minimal solution.xml and push it
      const workDir = path.join(this.tempDir, `solution-${Date.now()}`);
      await fs.mkdir(workDir, { recursive: true });

      // Initialize solution project structure
      const { stdout: initOutput, stderr: initStderr } = await this.execPac(
        `solution init --publisher-name "${publisherName}" --publisher-prefix ldv --outputDirectory "${workDir}"`,
        { timeout: 60000 },
      );

      this.logger.debug(`Solution init output: ${initOutput}`);
      if (initStderr) {
        this.logger.debug(`Solution init stderr: ${initStderr}`);
      }

      // Update the solution.xml with our solution name
      const solutionXmlPath = path.join(
        workDir,
        'src',
        'Other',
        'Solution.xml',
      );
      try {
        let solutionXml = await fs.readFile(solutionXmlPath, 'utf-8');
        // Replace the placeholder name with our solution name
        solutionXml = solutionXml.replace(
          /<UniqueName>.*?<\/UniqueName>/g,
          `<UniqueName>${solutionName}</UniqueName>`,
        );
        solutionXml = solutionXml.replace(
          /<LocalizedName description=".*?" languagecode="1033"\/>/g,
          `<LocalizedName description="${description}" languagecode="1033"/>`,
        );
        await fs.writeFile(solutionXmlPath, solutionXml);
        this.logger.debug(`Updated solution.xml with name: ${solutionName}`);
      } catch (xmlError) {
        this.logger.warn(`Could not update solution.xml: ${xmlError.message}`);
      }

      // Push the solution to Dataverse using pac solution push
      // This creates the solution in the connected environment
      try {
        const { stdout: pushOutput, stderr: pushStderr } = await this.execPac(
          `solution push --solution-folder "${workDir}"`,
          { timeout: 120000 },
        );
        this.logger.debug(`Solution push output: ${pushOutput}`);
        if (pushStderr) {
          this.logger.debug(`Solution push stderr: ${pushStderr}`);
        }
        this.logger.log(`Created solution in Dataverse: ${solutionName}`);
      } catch (pushError) {
        // If push fails, try using the solution-unique-name with add-solution-component
        // as it will create the solution if it doesn't exist with the right flags
        this.logger.warn(
          `Solution push failed: ${pushError.message}, trying alternate approach`,
        );
        throw pushError;
      }

      // Clean up local folder
      try {
        await fs.rm(workDir, { recursive: true, force: true });
      } catch {
        // Ignore cleanup errors
      }

      this.logger.log(`Created solution: ${solutionName}`);
    } catch (error) {
      this.logger.error(`Failed to create solution: ${error.message}`);
      throw new BadRequestException(
        `Failed to create solution: ${error.message}`,
      );
    }
  }

  /**
   * Add a component to an existing solution
   * Component types: CanvasApp, Entity, WebResource, etc.
   */
  async addComponentToSolution(
    solutionName: string,
    componentType: string,
    componentId: string,
  ): Promise<void> {
    try {
      const { stdout, stderr } = await this.execPac(
        `solution add-solution-component --solution-unique-name "${solutionName}" --component-type ${componentType} --object-id ${componentId}`,
        { timeout: 120000 },
      );

      if (stderr && !stderr.toLowerCase().includes('success')) {
        this.logger.warn(`Add component warning: ${stderr}`);
      }

      this.logger.log(
        `Added ${componentType} ${componentId} to solution ${solutionName}`,
      );
    } catch (error) {
      this.logger.error(
        `Failed to add component to solution: ${error.message}`,
      );
      throw new BadRequestException(
        `Failed to add component to solution: ${error.message}`,
      );
    }
  }

  /**
   * Export a solution as a .zip file
   */
  async exportSolution(
    solutionName: string,
    outputPath: string,
  ): Promise<string> {
    try {
      const outputDir = path.dirname(outputPath);
      await fs.mkdir(outputDir, { recursive: true });
      this.logger.debug(`Created output directory: ${outputDir}`);

      // Wait for the solution to become visible to PAC CLI
      // Solutions created via Dataverse API may take a few seconds to sync
      let solutionVisible = false;
      const maxAttempts = 5;
      const delayMs = 2000;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
          const { stdout: listOutput } = await this.execPac(`solution list`, {
            timeout: 60000,
          });
          this.logger.debug(
            `Available solutions (attempt ${attempt}): ${listOutput}`,
          );

          if (listOutput.includes(solutionName)) {
            solutionVisible = true;
            this.logger.log(
              `Solution ${solutionName} is visible (attempt ${attempt})`,
            );
            break;
          } else {
            this.logger.warn(
              `Solution ${solutionName} not found (attempt ${attempt}/${maxAttempts}), waiting ${delayMs}ms...`,
            );
            if (attempt < maxAttempts) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }
        } catch (listError) {
          this.logger.warn(
            `Could not list solutions (attempt ${attempt}): ${listError.message}`,
          );
          if (attempt < maxAttempts) {
            await new Promise((resolve) => setTimeout(resolve, delayMs));
          }
        }
      }

      if (!solutionVisible) {
        throw new Error(
          `Solution ${solutionName} not visible to PAC CLI after ${maxAttempts} attempts`,
        );
      }

      // Run the export command
      // Note: Use single quotes for arguments since execPac uses double quotes for PowerShell command
      const { stdout, stderr } = await this.execPac(
        `solution export --name '${solutionName}' --path '${outputPath}' --managed false --overwrite`,
        { timeout: 300000 }, // 5 minute timeout
      );

      // Log full output for debugging
      this.logger.debug(`Export stdout: ${stdout || '(empty)'}`);
      if (stderr) {
        this.logger.debug(`Export stderr: ${stderr}`);
      }

      // Check for error indicators in output
      const combinedOutput = (stdout || '') + (stderr || '');
      if (
        combinedOutput.toLowerCase().includes('error') ||
        combinedOutput.toLowerCase().includes('failed') ||
        combinedOutput.toLowerCase().includes('not found')
      ) {
        this.logger.error(`Export may have failed. Output: ${combinedOutput}`);
      }

      // Check if file was actually created
      try {
        const stats = await fs.stat(outputPath);
        this.logger.log(`Export verified: ${outputPath} (${stats.size} bytes)`);
      } catch (statError) {
        // File doesn't exist - check what files are in the directory
        try {
          const files = await fs.readdir(outputDir);
          this.logger.warn(
            `File not at expected path. Directory contents: ${files.join(', ') || '(empty)'}`,
          );

          // Check if file was created with a different name
          const zipFiles = files.filter((f) => f.endsWith('.zip'));
          if (zipFiles.length > 0) {
            const actualPath = path.join(outputDir, zipFiles[0]);
            this.logger.log(`Found solution at: ${actualPath}`);
            return actualPath;
          }
        } catch {
          // Ignore
        }

        // Provide more detailed error with diagnostic info
        throw new Error(
          `Export command completed but file not found. ` +
            `Solution: ${solutionName}, Path: ${outputPath}. ` +
            `Output: ${combinedOutput || '(no output)'}`,
        );
      }

      return outputPath;
    } catch (error) {
      this.logger.error(`Failed to export solution: ${error.message}`);
      throw new BadRequestException(
        `Failed to export solution: ${error.message}`,
      );
    }
  }

  /**
   * Import a solution from a .zip file
   */
  async importSolution(solutionPath: string): Promise<void> {
    try {
      await fs.access(solutionPath);

      const { stdout, stderr } = await this.execPac(
        `solution import --path '${solutionPath}' --async false`,
        { timeout: 600000 }, // 10 minute timeout for large solutions
      );

      if (stderr && !stderr.toLowerCase().includes('success')) {
        this.logger.warn(`Solution import warning: ${stderr}`);
      }

      this.logger.log(`Imported solution from: ${solutionPath}`);
    } catch (error) {
      this.logger.error(`Failed to import solution: ${error.message}`);
      throw new BadRequestException(
        `Failed to import solution: ${error.message}`,
      );
    }
  }

  /**
   * Delete a solution
   */
  async deleteSolution(solutionName: string): Promise<void> {
    try {
      const { stdout, stderr } = await this.execPac(
        `solution delete --solution-unique-name '${solutionName}'`,
        { timeout: 120000 },
      );

      this.logger.log(`Deleted solution: ${solutionName}`);
    } catch (error) {
      this.logger.warn(`Failed to delete solution: ${error.message}`);
      // Don't throw - this is cleanup
    }
  }

  /**
   * Get the app ID from a solution by looking up canvas apps
   */
  async getAppFromSolution(
    solutionName: string,
    displayName: string,
  ): Promise<string> {
    try {
      // List canvas apps and find the one matching our display name
      const { stdout } = await this.execPac(`canvas list`, { timeout: 60000 });

      // Parse output to find app with matching name
      // Output format varies, try to find UUID
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (line.toLowerCase().includes(displayName.toLowerCase())) {
          const uuidMatch = line.match(/([a-f0-9-]{36})/i);
          if (uuidMatch) {
            return uuidMatch[1];
          }
        }
      }

      // If not found by name, return a placeholder
      this.logger.warn(`Could not find app by name, returning placeholder`);
      return 'imported-app-id';
    } catch (error) {
      this.logger.warn(`Failed to get app from solution: ${error.message}`);
      return 'imported-app-id';
    }
  }

  /**
   * Delete an authentication profile
   */
  async deleteAuthProfile(profileName: string): Promise<void> {
    try {
      await this.execPac(`auth delete --name "${profileName}"`);
      this.logger.log(`Deleted PAC auth profile: ${profileName}`);
    } catch (error) {
      // Ignore if profile doesn't exist
      this.logger.warn(`Could not delete PAC auth profile: ${error.message}`);
    }
  }

  /**
   * Get a unique temp directory for operations
   */
  async getTempDir(prefix: string): Promise<string> {
    const dir = path.join(this.tempDir, `${prefix}-${Date.now()}`);
    await fs.mkdir(dir, { recursive: true });
    return dir;
  }
}
