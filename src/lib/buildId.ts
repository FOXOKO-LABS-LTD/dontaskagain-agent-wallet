// 0.3.2: «Sign» signs exactly the build the human saw. The id covers the whole view (recipient, amount,
// fees, resources, warnings, blocks) and the bytes behind it; the window sends it back and the worker signs only when it
// matches its own build — otherwise it shows the new build instead of signing it.
import { sha256Hex } from './wallet/doc';

export function buildIdOf(view: object, bytes: string[]): string {
  const { build_id, e2e, repeat, ...rest } = view as Record<string, unknown>;
  void build_id; void e2e; void repeat;
  return 'b_' + sha256Hex(JSON.stringify(rest) + '|' + bytes.join(',')).slice(0, 40);
}
