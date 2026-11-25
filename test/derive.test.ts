import { TronWeb } from 'tronweb';
import { hdAddresses, seedFromMnemonic, parsePrivateKey, addressesOfKey, isValidMnemonic, newMnemonic, PATH_TRON, PATH_EVM } from '../src/lib/wallet/derive';
import { tronToHex41, tronFromHex41, normalizeTron } from '../src/lib/tron/address';

// Standard BIP-39 test vector (public): "abandon ×11 about".
const ABOUT = 'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

describe('derivation', () => {
  const seed = seedFromMnemonic(ABOUT);
  it('index 0 matches public values (MetaMask / TronLink)', () => {
    const a = hdAddresses(seed, 0);
    expect(a.evm).toBe('0x9858EfFD232B4033E47d90003D41EC34EcaEda94');
    expect(a.tron).toBe('TUEZSdKsoDHQMeZwihtdoBiN46zxhGWYdH');
  });
  it('index 1 (address-level index, MetaMask scheme)', () => {
    const a = hdAddresses(seed, 1);
    expect(a.evm).toBe('0x6Fac4D18c912343BF86fa7049364Dd4E424Ab9C0');
    expect(a.tron).toBe('TSeJkUh4Qv67VNFwY8LaAxERygNdy6NQZK');
  });
  it('TRON addresses agree with tronweb for i = 0..3', () => {
    for (let i = 0; i < 4; i++) {
      const w = TronWeb.fromMnemonic(ABOUT, PATH_TRON(i)) as { address: string };
      expect(hdAddresses(seed, i).tron).toBe(w.address);
    }
  });
  it('paths', () => { expect(PATH_TRON(2)).toBe("m/44'/195'/0'/0/2"); expect(PATH_EVM(2)).toBe("m/44'/60'/0'/0/2"); });
  it('imported key gives TRON and EVM of the same key', () => {
    const k = parsePrivateKey('0x' + '0'.repeat(63) + '1');
    const a = addressesOfKey(k);
    expect(a.evm).toBe('0x7E5F4552091A69125d5DfCb7b8C2659029395Bdf');
    expect(a.tron).toBe(TronWeb.address.fromPrivateKey('0'.repeat(63) + '1'));
    expect(() => parsePrivateKey('12')).toThrow();
    expect(() => parsePrivateKey('0'.repeat(64))).toThrow();
  });
  it('mnemonic generation and validation', () => {
    expect(isValidMnemonic(ABOUT)).toBe(true);
    expect(isValidMnemonic(ABOUT.replace('about', 'abandon'))).toBe(false);
    expect(newMnemonic(12).split(' ')).toHaveLength(12);
    expect(newMnemonic(24).split(' ')).toHaveLength(24);
    expect(isValidMnemonic(newMnemonic())).toBe(true);
  });
  it('address codec', () => {
    expect(tronToHex41('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t')).toBe('41a614f803b6fd780986a42c78ec9c7f77e6ded13c');
    expect(tronFromHex41('41a614f803b6fd780986a42c78ec9c7f77e6ded13c')).toBe('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t');
    expect(() => normalizeTron('TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u')).toThrow();
  });
});
