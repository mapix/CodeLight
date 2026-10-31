import * as React from 'react';
import { Image } from 'react-native';

export const CodeLightMark = React.memo(function CodeLightMark({ size = 24 }: { size?: number }) {
    return <Image source={require('@/assets/images/codelight-mark.png')} accessibilityLabel="CodeLight" style={{ width: size, height: size, borderRadius: size * 0.22 }} />;
});
