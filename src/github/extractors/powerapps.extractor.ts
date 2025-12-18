import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import * as unzipper from 'unzipper';

/**
 * Extracted app structure from msapp
 */
export interface ExtractedPowerApp {
  extractPath: string;
  properties: any;
  screens: string[];
  srcFiles: string[];
}

/**
 * Service to extract and pack PowerApps msapp files
 *
 * The msapp format is essentially a ZIP containing:
 * - Properties.json - App metadata
 * - Header.json - Header info
 * - Src/*.pa.yaml - Screen definitions (YAML)
 * - Controls/*.json - Control definitions
 * - References/ - Data connections
 * - Resources/ - Assets (images, etc.)
 */
@Injectable()
export class PowerAppsExtractorService {
  private readonly logger = new Logger(PowerAppsExtractorService.name);
  private readonly tempDir: string;

  constructor(private readonly config: ConfigService) {
    this.tempDir = this.config.get<string>('TEMP_DIR') || os.tmpdir();
  }

  /**
   * Extract an msapp file to a temporary directory
   */
  async extractMsapp(msappBuffer: Buffer): Promise<ExtractedPowerApp> {
    const extractId = `msapp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const extractPath = path.join(this.tempDir, 'ldvbridge', extractId);

    // Ensure directory exists
    await fs.promises.mkdir(extractPath, { recursive: true });

    // Write buffer to temp file
    const tempMsappPath = path.join(this.tempDir, `${extractId}.msapp`);
    await fs.promises.writeFile(tempMsappPath, msappBuffer);

    // Extract using unzipper
    try {
      await pipeline(
        createReadStream(tempMsappPath),
        unzipper.Extract({ path: extractPath }),
      );
    } catch (error) {
      this.logger.error(`Failed to extract msapp: ${error}`);
      throw error;
    }

    // Clean up temp msapp file
    await fs.promises.unlink(tempMsappPath);

    // Parse extracted content
    const properties = await this.parsePropertiesJson(extractPath);
    const screens = await this.listScreens(extractPath);
    const srcFiles = await this.listSrcFiles(extractPath);

    this.logger.log(
      `Extracted msapp to ${extractPath}: ${screens.length} screens, ${srcFiles.length} source files`,
    );

    return {
      extractPath,
      properties,
      screens,
      srcFiles,
    };
  }

  /**
   * Extract from a local msapp file path
   */
  async extractFromPath(msappPath: string): Promise<ExtractedPowerApp> {
    const buffer = await fs.promises.readFile(msappPath);
    return this.extractMsapp(buffer);
  }

  /**
   * Parse Properties.json from extracted app
   */
  private async parsePropertiesJson(extractPath: string): Promise<any> {
    const propsPath = path.join(extractPath, 'Properties.json');

    if (!fs.existsSync(propsPath)) {
      return {};
    }

    const content = await fs.promises.readFile(propsPath, 'utf8');
    return JSON.parse(content);
  }

  /**
   * List screen names from Src folder
   */
  private async listScreens(extractPath: string): Promise<string[]> {
    const srcPath = path.join(extractPath, 'Src');

    if (!fs.existsSync(srcPath)) {
      return [];
    }

    const files = await fs.promises.readdir(srcPath);
    return files
      .filter((f) => f.endsWith('.pa.yaml') && !f.startsWith('_'))
      .map((f) => f.replace('.pa.yaml', ''));
  }

  /**
   * List all source files
   */
  private async listSrcFiles(extractPath: string): Promise<string[]> {
    const srcPath = path.join(extractPath, 'Src');

    if (!fs.existsSync(srcPath)) {
      return [];
    }

    const files = await fs.promises.readdir(srcPath);
    return files.filter((f) => f.endsWith('.pa.yaml'));
  }

  /**
   * Get the content of a specific screen file
   */
  async getScreenContent(
    extractPath: string,
    screenName: string,
  ): Promise<string> {
    const screenPath = path.join(extractPath, 'Src', `${screenName}.pa.yaml`);

    if (!fs.existsSync(screenPath)) {
      throw new Error(`Screen ${screenName} not found`);
    }

    return fs.promises.readFile(screenPath, 'utf8');
  }

  /**
   * Clean up extracted files
   */
  async cleanup(extractPath: string): Promise<void> {
    if (extractPath.includes('ldvbridge') && fs.existsSync(extractPath)) {
      await fs.promises.rm(extractPath, { recursive: true, force: true });
      this.logger.log(`Cleaned up extraction at ${extractPath}`);
    }
  }

  /**
   * Pack directory back into msapp format
   */
  async packMsapp(extractPath: string): Promise<Buffer> {
    const archiver = require('archiver');
    const chunks: Buffer[] = [];

    return new Promise((resolve, reject) => {
      const archive = archiver('zip', { zlib: { level: 9 } });

      archive.on('data', (chunk: Buffer) => chunks.push(chunk));
      archive.on('end', () => resolve(Buffer.concat(chunks)));
      archive.on('error', reject);

      archive.directory(extractPath, false);
      archive.finalize();
    });
  }

  /**
   * Get all files in extracted app as a structured object
   * Useful for committing to Git
   */
  async getFileTree(extractPath: string): Promise<Map<string, string>> {
    const files = new Map<string, string>();

    const processDir = async (dirPath: string, prefix: string = '') => {
      const entries = await fs.promises.readdir(dirPath, {
        withFileTypes: true,
      });

      for (const entry of entries) {
        const fullPath = path.join(dirPath, entry.name);
        const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;

        // Skip hidden files and large binary files
        if (entry.name.startsWith('.')) continue;

        if (entry.isDirectory()) {
          await processDir(fullPath, relativePath);
        } else {
          // Only include text files (YAML, JSON, etc.)
          const ext = path.extname(entry.name).toLowerCase();
          if (['.yaml', '.yml', '.json', '.txt', '.md', '.xml'].includes(ext)) {
            const content = await fs.promises.readFile(fullPath, 'utf8');
            files.set(relativePath, content);
          }
        }
      }
    };

    await processDir(extractPath);
    return files;
  }
}
