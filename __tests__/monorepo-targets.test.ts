import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodeGraph } from '../src/index';
import { associateBuildTargets, discoverBuildTargets, parseBuildToml } from '../src/monorepo-targets';
import { DatabaseConnection } from '../src/db';
import { QueryBuilder } from '../src/db/queries';

describe('build.toml monorepo targets', () => {
  it('parses project and lib fields from the supported manifest shape', () => {
    expect(parseBuildToml(`
      [project]
      core = "src"
      deps = ["rt", "vendor/im",]
      tags = ["app"]
    `)).toEqual({ kind: 'project', core: 'src', deps: ['rt', 'vendor/im'], tags: ['app'] });

    expect(parseBuildToml('[lib]\ndeps = []')).toEqual({ kind: 'lib', core: '.', deps: [], tags: [] });
  });

  it('discovers nested manifests with bounded excluded-directory traversal', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-targets-'));
    fs.mkdirSync(path.join(root, 'outer', 'inner'), { recursive: true });
    fs.mkdirSync(path.join(root, 'node_modules', 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(root, 'dist', 'ignored'), { recursive: true });
    fs.mkdirSync(path.join(root, 'obj', 'tracked'), { recursive: true });
    fs.writeFileSync(path.join(root, 'outer', 'build.toml'), '[project]\ncore = "."\n');
    fs.writeFileSync(path.join(root, 'outer', 'inner', 'build.toml'), '[lib]\ntags = ["nested"]\n');
    fs.writeFileSync(path.join(root, 'node_modules', 'ignored', 'build.toml'), '[lib]\n');
    fs.writeFileSync(path.join(root, 'dist', 'ignored', 'build.toml'), '[lib]\n');
    fs.writeFileSync(path.join(root, 'obj', 'tracked', 'build.toml'), '[lib]\n');

    expect(discoverBuildTargets(root).map((target) => target.path)).toEqual([
      'obj/tracked', 'outer', 'outer/inner',
    ]);
  });

  it('ignores missing and invalid manifests without failing discovery', () => {
    expect(parseBuildToml('[project]\ndeps = ["unterminated"')).toBeNull();
    expect(parseBuildToml('[project]\ncore = ["not-a-string"]')).toBeNull();
    expect(parseBuildToml('[project]\ndeps = ["one",,]')).toBeNull();
    expect(discoverBuildTargets(fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-targets-empty-')))).toEqual([]);
  });

  it('associates files with the longest matching target path', () => {
    const targets = [
      { path: '.', name: '.', kind: 'project' as const, manifestPath: 'build.toml', core: '.', deps: [], tags: [] },
      { path: 'rt', name: 'rt', kind: 'lib' as const, manifestPath: 'rt/build.toml', core: '.', deps: [], tags: [] },
      { path: 'rt/ui', name: 'rt/ui', kind: 'lib' as const, manifestPath: 'rt/ui/build.toml', core: '.', deps: ['rt'], tags: [] },
    ];
    const associations = associateBuildTargets(targets, ['root.odin', 'rt/base.odin', 'rt/ui/panel.odin', 'other/nope.odin']);
    expect(associations.get('.')!).toEqual(['root.odin', 'other/nope.odin']);
    expect(associations.get('rt')!).toEqual(['rt/base.odin']);
    expect(associations.get('rt/ui')!).toEqual(['rt/ui/panel.odin']);
  });

  it('persists target metadata and file associations through the query layer', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-target-db-'));
    const connection = DatabaseConnection.initialize(path.join(root, 'test.db'));
    const queries = new QueryBuilder(connection.getDb());
    const targets = [{
      path: 'rt/ui', name: 'rt/ui', kind: 'lib' as const, manifestPath: 'rt/ui/build.toml', core: '.', deps: ['rt'], tags: ['ui'],
    }];

    queries.replaceMonorepoTargets(targets, new Map([['rt/ui', ['rt/ui/panel.odin']]]));
    expect(queries.getMonorepoTargets()).toEqual(targets);
    expect(queries.getMonorepoTargetFiles('rt/ui')).toEqual(['rt/ui/panel.odin']);
    expect(connection.getSchemaVersion()?.version).toBe(10);
    connection.close();
  });

  it('refreshes target associations after a scoped source sync', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-targets-sync-'));
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pkg', 'build.toml'), '[lib]\n');
    fs.writeFileSync(path.join(root, 'pkg', 'one.ts'), 'export const one = 1;\n');

    const graph = CodeGraph.initSync(root);
    try {
      await graph.indexAll();
      expect(graph.getTargetFiles('pkg')).toEqual(['pkg/one.ts']);

      fs.writeFileSync(path.join(root, 'pkg', 'two.ts'), 'export const two = 2;\n');
      await graph.sync({ paths: ['pkg/two.ts'] });

      expect(graph.getTargetFiles('pkg')).toEqual(['pkg/one.ts', 'pkg/two.ts']);

      fs.rmSync(path.join(root, 'pkg', 'one.ts'));
      await graph.sync({ paths: ['pkg/one.ts'] });

      expect(graph.getTargetFiles('pkg')).toEqual(['pkg/two.ts']);
    } finally {
      graph.destroy();
    }
  });

  it('refreshes target metadata after a scoped manifest sync', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codegraph-targets-manifest-'));
    fs.mkdirSync(path.join(root, 'pkg'), { recursive: true });
    const manifestPath = path.join(root, 'pkg', 'build.toml');
    fs.writeFileSync(manifestPath, '[lib]\ndeps = ["first"]\ntags = ["old"]\n');
    fs.writeFileSync(path.join(root, 'pkg', 'one.ts'), 'export const one = 1;\n');

    const graph = CodeGraph.initSync(root);
    try {
      await graph.indexAll();
      expect(graph.getTargets()[0]?.deps).toEqual(['first']);

      fs.writeFileSync(manifestPath, '[lib]\ndeps = ["second"]\ntags = ["new"]\n');
      await graph.sync({ paths: ['pkg/build.toml'] });

      expect(graph.getTargets()[0]).toMatchObject({ deps: ['second'], tags: ['new'] });
    } finally {
      graph.destroy();
    }
  });
});
