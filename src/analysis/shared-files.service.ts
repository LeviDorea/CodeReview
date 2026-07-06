import { Injectable, Logger } from '@nestjs/common';
import { GithubService } from '../github/github.service';
import {
  detectLanguageFromFilename,
  normalizePath,
} from '../common/utils/file-language.util';

const IMPORT_PATTERNS: Record<string, RegExp[]> = {
  typescript: [
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  javascript: [
    /import\s+.*?\s+from\s+['"]([^'"]+)['"]/g,
    /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ],
  python: [
    /^from\s+([\w.]+)\s+import/gm,
    /^import\s+([\w.]+)/gm,
  ],
};

const CAKE_ARRAY_ASSIGNMENT_RE =
  /\$(uses|belongsTo|hasMany|hasOne|hasAndBelongsToMany)\s*=\s*([\s\S]*?);/g;
const CAKE_APP_USES_RE =
  /App::uses\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]\s*,\s*['"]([^'"]+)['"]\s*\)/g;
const CAKE_LOAD_MODEL_RE =
  /(?:\$this->loadModel|ClassRegistry::init)\(\s*['"]([A-Z][A-Za-z0-9_]*)['"]\s*\)/g;
const CAKE_MODEL_CALL_RE = /\$this->([A-Z][A-Za-z0-9_]*)->/g;
const MAX_CONTEXT_FILE_CHARS = 6000;

@Injectable()
export class SharedFilesService {
  private readonly logger = new Logger(SharedFilesService.name);

  constructor(private readonly github: GithubService) {}

  extractRelativeImports(content: string, language: string): string[] {
    const patterns = IMPORT_PATTERNS[language.toLowerCase()] ?? [];
    const imports = new Set<string>();

    for (const pattern of patterns) {
      const regex = new RegExp(pattern.source, pattern.flags);
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const importPath = match[1];
        if (importPath && (importPath.startsWith('./') || importPath.startsWith('../'))) {
          imports.add(importPath);
        }
      }
    }

    return Array.from(imports);
  }

  async fetchSharedFilesContext(
    owner: string,
    repo: string,
    installationId: number,
    changedFiles: Array<{ filename: string; patch: string }>,
    ref: string,
    extraContextPaths: string[] = [],
  ): Promise<string> {
    const changedFilePaths = new Set(
      changedFiles.map((file) => normalizePath(file.filename)),
    );
    const sharedPaths = new Set(
      extraContextPaths.map((filePath) => normalizePath(filePath)).filter(Boolean),
    );
    const fileContentCache = new Map<string, string | null>();

    const getFileContent = async (path: string): Promise<string | null> => {
      const normalizedPath = normalizePath(path);
      if (fileContentCache.has(normalizedPath)) {
        return fileContentCache.get(normalizedPath) ?? null;
      }

      try {
        const content = await this.github.getFileContent(
          owner,
          repo,
          normalizedPath,
          installationId,
          ref,
        );
        fileContentCache.set(normalizedPath, content || null);
        return content || null;
      } catch (e) {
        this.logger.warn(`Could not fetch shared file: ${normalizedPath}`);
        fileContentCache.set(normalizedPath, null);
        return null;
      }
    };

    for (const file of changedFiles) {
      const language = detectLanguageFromFilename(file.filename);
      if (!language) {
        continue;
      }

      const content = await this.getAnalysisSourceContent(
        file,
        language,
        getFileContent,
      );
      const imports = this.extractRelativeImports(content, language);
      for (const imp of imports) {
        const resolved = this.resolveImportPath(file.filename, imp);
        if (resolved) sharedPaths.add(resolved);
      }

      if (language === 'php') {
        for (const relatedPath of this.extractCakeConventionPaths(
          file.filename,
          content,
        )) {
          sharedPaths.add(relatedPath);
        }
      }
    }

    // Convention-derived candidates include paths that may not exist (core
    // Cake classes, helpers matched as models). One tree call decides
    // membership for all of them instead of a 404 per candidate.
    const existingPaths =
      sharedPaths.size > 0
        ? await this.github.getRepoTreePaths(owner, repo, ref, installationId)
        : null;

    const contents: string[] = [];
    for (const path of sharedPaths) {
      const normalizedPath = normalizePath(path);
      if (changedFilePaths.has(normalizedPath)) {
        continue;
      }
      if (existingPaths && !existingPaths.has(normalizedPath)) {
        continue;
      }

      const content = await getFileContent(normalizedPath);
      if (content) {
        contents.push(this.formatContextFile(normalizedPath, content));
      }
    }

    return contents.join('\n\n---\n\n');
  }

  private async getAnalysisSourceContent(
    file: { filename: string; patch: string },
    language: string,
    getFileContent: (path: string) => Promise<string | null>,
  ): Promise<string> {
    if (language !== 'php') {
      return this.currentStateLines(file.patch);
    }

    const fullContent = await getFileContent(file.filename);
    return fullContent || this.currentStateLines(file.patch);
  }

  private formatContextFile(path: string, content: string): string {
    const truncatedContent = this.truncateContextContent(content);
    return `// Context only. Do not report standalone issues for this file.\n// File: ${path}\n${truncatedContent}`;
  }

  private truncateContextContent(content: string): string {
    if (content.length <= MAX_CONTEXT_FILE_CHARS) {
      return content;
    }

    return [
      content.slice(0, MAX_CONTEXT_FILE_CHARS),
      '',
      `// [truncated after ${MAX_CONTEXT_FILE_CHARS} characters]`,
    ].join('\n');
  }

  private extractCakeConventionPaths(
    filename: string,
    content: string,
  ): string[] {
    const appRoot = this.extractCakeAppRoot(filename);
    if (!appRoot) {
      return [];
    }

    const relatedPaths = new Set<string>();
    this.addCakeInheritancePaths(filename, content, appRoot, relatedPaths);
    this.addCakeReferencePaths(content, appRoot, relatedPaths);

    const expectedTestPath = this.resolveExpectedCakeTestPath(filename);
    if (expectedTestPath) {
      relatedPaths.add(expectedTestPath);
    }

    const sourcePath = this.resolveCakeSourcePathFromTest(filename);
    if (sourcePath) {
      relatedPaths.add(sourcePath);
    }

    relatedPaths.delete(normalizePath(filename));
    return Array.from(relatedPaths);
  }

  private addCakeInheritancePaths(
    filename: string,
    content: string,
    appRoot: string,
    relatedPaths: Set<string>,
  ) {
    const normalizedFilename = normalizePath(filename);
    const extendsMatch = content.match(
      /class\s+[A-Za-z_][A-Za-z0-9_]*\s+extends\s+([A-Z][A-Za-z0-9_]*)/,
    );
    const parentClass = extendsMatch?.[1] ?? null;

    if (
      /\/app\/Controller\/.+\.php$/i.test(normalizedFilename) ||
      /\/app\/Test\/Case\/Controller\/.+Test\.php$/i.test(normalizedFilename) ||
      parentClass === 'AppController'
    ) {
      relatedPaths.add(`${appRoot}Controller/AppController.php`);
    }

    if (
      /\/app\/Model\/.+\.php$/i.test(normalizedFilename) ||
      /\/app\/Test\/Case\/Model\/.+Test\.php$/i.test(normalizedFilename) ||
      parentClass === 'AppModel'
    ) {
      relatedPaths.add(`${appRoot}Model/AppModel.php`);
    }
  }

  private addCakeReferencePaths(
    content: string,
    appRoot: string,
    relatedPaths: Set<string>,
  ) {
    for (const match of content.matchAll(CAKE_APP_USES_RE)) {
      const resolved = this.resolveCakeAppUsesPath(appRoot, match[1], match[2]);
      if (resolved) {
        relatedPaths.add(resolved);
      }
    }

    for (const className of this.extractCakeArrayAssignmentClassNames(content)) {
      relatedPaths.add(`${appRoot}Model/${className}.php`);
    }

    for (const match of content.matchAll(CAKE_LOAD_MODEL_RE)) {
      relatedPaths.add(`${appRoot}Model/${match[1]}.php`);
    }

    for (const match of content.matchAll(CAKE_MODEL_CALL_RE)) {
      relatedPaths.add(`${appRoot}Model/${match[1]}.php`);
    }
  }

  private extractCakeArrayAssignmentClassNames(content: string): string[] {
    const classNames = new Set<string>();

    for (const match of content.matchAll(CAKE_ARRAY_ASSIGNMENT_RE)) {
      for (const quotedClassName of match[2].matchAll(
        /['"]([A-Z][A-Za-z0-9_]*)['"]/g,
      )) {
        classNames.add(quotedClassName[1]);
      }
    }

    return Array.from(classNames);
  }

  private extractCakeAppRoot(file: string): string | null {
    const match = normalizePath(file).match(/^((?:.*\/)?app\/)/);
    return match?.[1] ?? null;
  }

  private resolveExpectedCakeTestPath(sourceFile: string): string | null {
    const normalized = normalizePath(sourceFile);
    const controllerMatch = normalized.match(
      /^((?:.*\/)?app\/)Controller\/([^/]+)\.php$/,
    );
    if (controllerMatch) {
      return `${controllerMatch[1]}Test/Case/Controller/${controllerMatch[2]}Test.php`;
    }

    const modelMatch = normalized.match(/^((?:.*\/)?app\/)Model\/([^/]+)\.php$/);
    if (modelMatch) {
      return `${modelMatch[1]}Test/Case/Model/${modelMatch[2]}Test.php`;
    }

    return null;
  }

  private resolveCakeSourcePathFromTest(testFile: string): string | null {
    const normalized = normalizePath(testFile);
    const controllerMatch = normalized.match(
      /^((?:.*\/)?app\/)Test\/Case\/Controller\/([^/]+)Test\.php$/,
    );
    if (controllerMatch) {
      return `${controllerMatch[1]}Controller/${controllerMatch[2]}.php`;
    }

    const modelMatch = normalized.match(
      /^((?:.*\/)?app\/)Test\/Case\/Model\/([^/]+)Test\.php$/,
    );
    if (modelMatch) {
      return `${modelMatch[1]}Model/${modelMatch[2]}.php`;
    }

    return null;
  }

  private resolveCakeAppUsesPath(
    appRoot: string,
    className: string,
    kind: string,
  ): string | null {
    const normalizedKind = kind.replace(/\./g, '/').replace(/^\/+|\/+$/g, '');
    if (!normalizedKind) {
      return null;
    }

    return `${appRoot}${normalizedKind}/${className}.php`;
  }

  /**
   * Keeps only the lines that are actually present in the file at the diff's
   * head (added `+` and unchanged context lines), dropping removed `-`
   * lines. Without this, an import deleted by this very PR still matches
   * the regex and gets resolved/fetched as "shared context" noise.
   */
  private currentStateLines(patch: string): string {
    return patch
      .split('\n')
      .filter(
        (line) =>
          !line.startsWith('@@') && !line.startsWith('+++') && !line.startsWith('---'),
      )
      .filter((line) => line.startsWith('+') || line.startsWith(' '))
      .map((line) => line.slice(1))
      .join('\n');
  }

  private resolveImportPath(fromFile: string, importPath: string): string | null {
    const parts = normalizePath(fromFile).split('/');
    parts.pop();
    const resolved = [...parts, ...importPath.split('/')].reduce(
      (acc: string[], part) => {
        if (part === '..') acc.pop();
        else if (part !== '.') acc.push(part);
        return acc;
      },
      [],
    );
    const candidate = resolved.join('/');
    return candidate || null;
  }
}
