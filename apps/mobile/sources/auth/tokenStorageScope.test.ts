import { afterEach, expect, it, vi } from 'vitest';
const { getItem, setItem, deleteItem, origin } = vi.hoisted(() => ({ getItem: vi.fn(), setItem: vi.fn(), deleteItem: vi.fn(), origin: { current: 'https://fixture.example' } }));
vi.mock('expo-secure-store', () => ({ getItemAsync: getItem, setItemAsync: setItem, deleteItemAsync: deleteItem }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' } }));
vi.mock('@/sync/serverConfig', () => ({ getServerUrl: () => origin.current }));
import { TokenStorage } from './tokenStorage';
afterEach(() => { getItem.mockReset(); setItem.mockReset(); deleteItem.mockReset(); origin.current = 'https://fixture.example'; });

it('does not return stored credentials bound to another selected server', async () => {
    getItem.mockResolvedValue(JSON.stringify({ token: 'fixture-token', secret: 'fixture-secret', serverUrl: 'https://other.example' }));
    expect(await TokenStorage.getCredentials()).toBeNull();
});
it('stores credentials with the frozen selected server origin', async () => {
    setItem.mockResolvedValue(undefined);
    expect(await TokenStorage.setCredentials({ token: 'fixture-token', secret: 'fixture-secret' })).toBe(true);
    expect(JSON.parse(setItem.mock.calls[0][1])).toMatchObject({ serverUrl: 'https://fixture.example' });
});
it('returns failure when native secure storage rejects the credential write', async () => {
    setItem.mockRejectedValue(Error('fixture Keychain unavailable'));
    expect(await TokenStorage.setCredentials({ token: 'fixture-token', secret: 'fixture-secret' })).toBe(false);
});
