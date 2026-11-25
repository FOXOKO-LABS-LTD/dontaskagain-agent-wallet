// 0.2.2 : the wallet's own accounts are trusted recipients — every account of every phrase and every
// imported key. Exact match → «your account: <name> (<phrase>)», no «first transfer / not in the book / check the address»;
// an address that only looks like one of them is flagged red like a look-alike of a book entry.
import { findSimilar, familyOf, sameAddress, type BookEntry, type SimilarCfg, type SimilarHit } from './similar';
import type { Account, Secrets } from './wallet/model';
import { t } from '../i18n';

export interface OwnMatch { id: string; name: string; group: string }
export interface OwnEntry { id: string; name: string; group: string; label: string; network: 'tron' | 'evm:*'; address: string }

/** Live accounts as recipients of one network family; `group` = the phrase name or «key». */
export function ownEntries(accounts: Account[], secrets: Pick<Secrets, 'seeds'>, network: string): OwnEntry[] {
  const fam = familyOf(network);
  const first = secrets.seeds?.[0];
  return accounts.filter((a) => !a.removed_at).flatMap((a) => {
    const address = fam === 'tron' ? a.addresses.tron : fam === 'evm' ? a.addresses.evm : undefined;
    if (!address) return [];
    const group = a.origin === 'imported' ? t('common.tagKey') : secrets.seeds?.find((x) => x.id === (a.seed_id ?? first?.id))?.name ?? t('common.tagPhrase');
    return [{ id: a.id, name: a.name, group, label: `${a.name} (${group})`, network: fam === 'tron' ? 'tron' as const : 'evm:*' as const, address }];
  });
}

export function ownMatch(own: OwnEntry[], network: string, address: string): OwnMatch | undefined {
  const o = own.find((x) => sameAddress(network, x.address, address));
  return o ? { id: o.id, name: o.name, group: o.group } : undefined;
}

/** The recipient check of a send (sign window and the «To» step). */
export function recipientCheck(p: { network: string; address: string; own: OwnEntry[]; book: BookEntry[]; history: { address: string; network: string }[]; cfg: SimilarCfg; firstTime: boolean }):
  { own?: OwnMatch; similar: SimilarHit[]; first_time: boolean } {
  const own = ownMatch(p.own, p.network, p.address);
  const similar = findSimilar(p.network, p.address, p.book, p.history, p.cfg, p.own);
  return { ...(own ? { own } : {}), similar, first_time: own ? false : p.firstTime };
}
