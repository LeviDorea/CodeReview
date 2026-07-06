import { SharedFilesService } from './shared-files.service';

const mockGithub = {
  getFileContent: jest.fn(),
  getRepoTreePaths: jest.fn(),
};

function makeService() {
  return new SharedFilesService(mockGithub as any);
}

describe('SharedFilesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    // null = tree unavailable → no path filtering, preserving each test's
    // own getFileContent expectations unless it opts into a tree.
    mockGithub.getRepoTreePaths.mockResolvedValue(null);
  });

  describe('extractRelativeImports', () => {
    it('should extract relative TS imports', () => {
      const svc = makeService();
      const content = `
        import { Foo } from './foo';
        import { Bar } from '../bar/baz';
        import { Ext } from '@nestjs/common';
      `;
      const result = svc.extractRelativeImports(content, 'typescript');
      expect(result).toContain('./foo');
      expect(result).toContain('../bar/baz');
      expect(result).not.toContain('@nestjs/common');
    });

    it('should extract relative require calls', () => {
      const svc = makeService();
      const content = `const x = require('./utils/helper');`;
      const result = svc.extractRelativeImports(content, 'javascript');
      expect(result).toContain('./utils/helper');
    });

    it('should return empty array for unknown language', () => {
      const svc = makeService();
      const result = svc.extractRelativeImports("from foo import bar", 'go');
      expect(result).toEqual([]);
    });
  });

  describe('fetchSharedFilesContext', () => {
    it('should fetch and return content for relative imports added in the diff', async () => {
      mockGithub.getFileContent.mockResolvedValue('export const x = 1;');
      const svc = makeService();

      const files = [
        { filename: 'src/app.ts', patch: `@@ -1 +1 @@\n+import { x } from './utils';` },
      ];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(mockGithub.getFileContent).toHaveBeenCalledWith('org', 'repo', 'src/utils', 1, 'sha123');
      expect(result).toContain('export const x = 1;');
      expect(result).toContain('Context only. Do not report standalone issues for this file.');
    });

    it('should fetch and return content for relative imports left untouched as diff context', async () => {
      mockGithub.getFileContent.mockResolvedValue('export const x = 1;');
      const svc = makeService();

      const files = [
        {
          filename: 'src/app.ts',
          patch: `@@ -1,2 +1,2 @@\n import { x } from './utils';\n-const y = 1;\n+const y = 2;`,
        },
      ];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(mockGithub.getFileContent).toHaveBeenCalledWith('org', 'repo', 'src/utils', 1, 'sha123');
      expect(result).toContain('export const x = 1;');
    });

    it('should not resolve or fetch an import that was removed by this PR', async () => {
      const svc = makeService();

      const files = [
        {
          filename: 'src/app.ts',
          patch: `@@ -1,2 +1,1 @@\n-import { x } from './removed';\n-const y = x;\n+const y = 1;`,
        },
      ];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(mockGithub.getFileContent).not.toHaveBeenCalled();
      expect(result).toBe('');
    });

    it('should skip files that fail to fetch', async () => {
      mockGithub.getFileContent.mockRejectedValue(new Error('not found'));
      const svc = makeService();

      const files = [
        { filename: 'src/app.ts', patch: `@@ -1 +1 @@\n+import { x } from './missing';` },
      ];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');
      expect(result).toBe('');
    });

    it('should return empty string when no relative imports found', async () => {
      const svc = makeService();
      const files = [
        {
          filename: 'src/app.ts',
          patch: `@@ -1 +1 @@\n+import { Injectable } from '@nestjs/common';`,
        },
      ];
      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');
      expect(result).toBe('');
      expect(mockGithub.getFileContent).not.toHaveBeenCalled();
    });

    it('should detect language per file and skip unsupported extensions', async () => {
      mockGithub.getFileContent.mockResolvedValue('export const helper = true;');
      const svc = makeService();
      const files = [
        { filename: 'src/app.ts', patch: `@@ -1 +1 @@\n+import { helper } from './helper';` },
        { filename: 'assets/logo.svg', patch: `@@ -1 +1 @@\n+<svg></svg>` },
      ];

      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(result).toContain('export const helper = true;');
      expect(mockGithub.getFileContent).toHaveBeenCalledTimes(1);
    });

    it('should infer CakePHP context files by convention for PHP changes', async () => {
      mockGithub.getFileContent.mockImplementation(
        (_owner: string, _repo: string, path: string) => {
          const contents: Record<string, string> = {
            'php/app/Controller/PedidosController.php': `
              App::uses('AppController', 'Controller');
              class PedidosController extends AppController {
                public $uses = array('Pedido');

                public function warRoom() {
                  return $this->Pedido->buildWarRoomSnapshot();
                }
              }
            `,
            'php/app/Controller/AppController.php': 'class AppController extends Controller {}',
            'php/app/Model/Pedido.php': 'class Pedido extends AppModel {}',
            'php/app/Test/Case/Controller/PedidosControllerTest.php':
              'class PedidosControllerTest extends ControllerTestCase {}',
          };

          return Promise.resolve(contents[path] ?? '');
        },
      );

      const svc = makeService();
      const files = [
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: '@@ -1 +1 @@\n+$this->Pedido->buildWarRoomSnapshot();',
        },
      ];

      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(result).toContain('// File: php/app/Controller/AppController.php');
      expect(result).toContain('// File: php/app/Model/Pedido.php');
      expect(result).toContain(
        '// File: php/app/Test/Case/Controller/PedidosControllerTest.php',
      );
    });

    it('should not fetch convention-derived paths that are absent from the repo tree', async () => {
      mockGithub.getRepoTreePaths.mockResolvedValue(
        new Set([
          'php/app/Controller/PedidosController.php',
          'php/app/Model/Pedido.php',
        ]),
      );
      mockGithub.getFileContent.mockImplementation(
        (_owner: string, _repo: string, path: string) => {
          const contents: Record<string, string> = {
            'php/app/Controller/PedidosController.php': `
              App::uses('NotFoundException', 'Error');
              class PedidosController extends AppController {
                public function view() {
                  return $this->Pedido->read();
                }
              }
            `,
            'php/app/Model/Pedido.php': 'class Pedido extends AppModel {}',
          };
          return Promise.resolve(contents[path] ?? '');
        },
      );

      const svc = makeService();
      const files = [
        {
          filename: 'php/app/Controller/PedidosController.php',
          patch: '@@ -1 +1 @@\n+return $this->Pedido->read();',
        },
      ];

      const result = await svc.fetchSharedFilesContext('org', 'repo', 1, files, 'sha123');

      expect(result).toContain('// File: php/app/Model/Pedido.php');
      // Cake core class resolved by convention but absent from the tree:
      // never fetched, so no 404 round-trip.
      const fetchedPaths = mockGithub.getFileContent.mock.calls.map((call) => call[2]);
      expect(fetchedPaths).not.toContain('php/app/Error/NotFoundException.php');
      expect(fetchedPaths).not.toContain('php/app/Controller/AppController.php');
    });

    it('should include explicit rule evidence files as read-only context', async () => {
      mockGithub.getFileContent.mockResolvedValue('# Repo conventions');
      const svc = makeService();

      const result = await svc.fetchSharedFilesContext(
        'org',
        'repo',
        1,
        [],
        'sha123',
        ['AGENTS.md'],
      );

      expect(mockGithub.getFileContent).toHaveBeenCalledWith(
        'org',
        'repo',
        'AGENTS.md',
        1,
        'sha123',
      );
      expect(result).toContain('// File: AGENTS.md');
    });
  });
});
