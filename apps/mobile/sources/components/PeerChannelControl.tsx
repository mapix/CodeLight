import * as React from 'react';
import type { StyleProp, ViewStyle } from 'react-native';
import { getConnectionSnapshot, subscribeConnection, selectConnection } from '@/sync/codeLightConnection';
import { PeerChannelControlView } from './PeerChannelControlView';

export { PeerChannelControlView, type PeerChannelSnapshot } from './PeerChannelControlView';

/** Shared peer selection owner; UI state cannot replace its authenticated route. */
export const PeerChannelControl = React.memo(function PeerChannelControl({ style, presentation, showDivider }: { style?: StyleProp<ViewStyle>; presentation?: 'compact' | 'settings' | 'header'; showDivider?: boolean }) {
    const snapshot = React.useSyncExternalStore(subscribeConnection, getConnectionSnapshot);
    return <PeerChannelControlView snapshot={snapshot} onSelect={selectConnection} style={style} presentation={presentation} showDivider={showDivider} />;
});
