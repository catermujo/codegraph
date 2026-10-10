import * as path from 'path';
import { validatePathWithinRoot } from '../utils';

export function resolveExploreScope(root: string, files: readonly string[], scope: string):
  { path: string; files: string[]; exactFile: boolean } | { message: string } {
  const absolute = validatePathWithinRoot(root, scope);
  if (absolute === null) return { message: `Search scope "${scope}" is outside the index root.` };
  const relative = path.relative(root, path.resolve(root, scope)).split(path.sep).join('/');
  const exactFile = files.includes(relative);
  const matched = files.filter(file => relative === '' || file === relative || file.startsWith(`${relative}/`));
  if (matched.length === 0) {
    const suffix = scope.replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '');
    const choices = files.filter(file => file === suffix || file.endsWith(`/${suffix}`)).slice(0, 8);
    return { message: `No indexed files in search scope "${scope}". Use a path relative to the index root.`
      + (choices.length ? ` Candidates: ${choices.map(file => `\`${file}\``).join(', ')}.` : '') };
  }
  return { path: relative || '.', files: matched, exactFile };
}
