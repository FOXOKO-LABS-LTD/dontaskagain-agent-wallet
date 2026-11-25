// An agent without a key of its own, as an older version of the extension left it (it asks in plaintext through the
// Signer): created with a key, then the key state is dropped from the vault — exactly how such an agent is stored.

export async function keylessAgent(call: (c: any) => Promise<any>, name: string, accounts: string[]): Promise<string> {
  const { updateVault } = await import('../../src/background/wallet'); // after the fake chrome is installed
  const r = await call({ cmd: 'agentCreate', name, accounts, launch: 'npx' });
  await updateVault((v) => { const a = v.agents[r.id]; delete a.pairing; delete a.e2e; });
  return r.id;
}
