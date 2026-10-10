import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { ExploreSessionState, type ExploreSessionView } from '../mcp/explore-session-state';

export function loadExploreContext(root: string, conversationId: string, contextEpoch: string): {
  state: ExploreSessionState;
  save: () => void;
} {
  const state = new ExploreSessionState();
  state.selectContext(conversationId, contextEpoch);
  const identity = state.view().contextIdentity;
  const key = createHash('sha256').update(identity!).digest('hex');
  const directory = path.join(root, '.codegraph', 'explore-context');
  const filename = path.join(directory, `${key}.json`);
  // DUMBAI: Context files contain source fingerprints and ranges only. A damaged cache re-serves source.
  try {
    if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) throw new Error('Unsafe context directory');
    if (!fs.lstatSync(filename).isFile() || fs.lstatSync(filename).isSymbolicLink()) throw new Error('Unsafe context file');
    if (fs.statSync(filename).size > 1_048_576) throw new Error('Context cache exceeds its bound');
    const view: ExploreSessionView = JSON.parse(fs.readFileSync(filename, 'utf8'));
    if (view.contextIdentity === identity && Array.isArray(view.projects)
      && view.projects.every(project => typeof project.projectRoot === 'string' && Array.isArray(project.calls)
        && project.calls.every(call => Array.isArray(call.files)
          && call.files.every(file => typeof file.path === 'string' && Array.isArray(file.ranges))))) {
      state.restore(view);
    }
  } catch {
    state.clear();
    state.selectContext(conversationId, contextEpoch);
  }
  return {
    state,
    save: () => {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      if (!fs.lstatSync(directory).isDirectory() || fs.lstatSync(directory).isSymbolicLink()) {
        throw new Error('Context directory must be a real directory');
      }
      const temporary = path.join(directory, `${key}.${randomUUID()}.tmp`);
      try {
        fs.writeFileSync(temporary, JSON.stringify(state.view()), { flag: 'wx', mode: 0o600 });
        // DUMBAI: Concurrent calls may lose recall when the last snapshot wins; they cannot invent held source.
        fs.renameSync(temporary, filename);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    },
  };
}
