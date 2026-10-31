import * as React from 'react';
import { Image, View } from 'react-native';
import { useUnistyles } from 'react-native-unistyles';
/** One generated CodeLight identity shared with the Mac App and native icon. */
export const HappyEngineeringWordmark = React.memo(function CodeLightWordmark({ height }: { height: number }) {
    const { theme } = useUnistyles();
    return <View testID="codelight-wordmark" accessible accessibilityLabel="CodeLight" style={{ height, justifyContent: 'center' }}>
        <Image source={theme.dark ? require('@/assets/images/codelight-wordmark-dark.png') : require('@/assets/images/codelight-wordmark.png')} resizeMode="contain" style={{ width: 264, height: Math.min(height, 80) }} />
    </View>;
});
