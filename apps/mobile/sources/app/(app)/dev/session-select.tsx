import * as React from 'react';
import { View } from 'react-native';
import { StyleSheet } from 'react-native-unistyles';
import { ProjectSessionSelect } from '@/components/ProjectSessionSelect';
import { Text } from '@/components/StyledText';
import { CodeLightProjectStatusView } from '@/components/CodeLightProjectStatus';
import { CodeLightSessionStatusView } from '@/components/CodeLightSessionStatus';

// 独立原生交互验收夹具，仅用本地合成会话，不连接或修改真实 Agent。
const options = Array.from({ length: 150 }, (_, index) => ({
    key: `fixture-session-${index}`,
    label: `会话 ${index + 1}：验证很多会话和很长的中文标题仍然能够选择`,
}));

export default function SessionSelectPreview() {
    const [selectedId, setSelectedId] = React.useState(options[0].key);
    return (
        <View style={styles.screen}>
            <View style={styles.control}>
                <ProjectSessionSelect options={options} selectedId={selectedId} onSelect={setSelectedId} />
            </View>
            <Text testID="session-select-result">{selectedId}</Text>
            <CodeLightProjectStatusView activity={{ total: 150, active: 3, waiting: 2, unknown: 1, status: 'ready', observedAt: 1 }} />
            <CodeLightProjectStatusView activity={{ total: 150, active: 0, waiting: 0, unknown: 150, status: 'unavailable', observedAt: 0 }} />
            <CodeLightSessionStatusView activity={{ known: true, active: true, waiting: false, status: 'ready', observedAt: 1 }} />
            <CodeLightSessionStatusView activity={{ known: true, active: true, waiting: true, status: 'ready', observedAt: 1 }} />
            <CodeLightSessionStatusView activity={{ known: true, active: false, waiting: false, status: 'ready', observedAt: 1 }} />
            <CodeLightSessionStatusView activity={{ known: false, active: false, waiting: false, status: 'ready', observedAt: 1 }} />
        </View>
    );
}

const styles = StyleSheet.create((theme) => ({
    screen: { flex: 1, paddingHorizontal: 16, paddingTop: 160, gap: 24, backgroundColor: theme.colors.groupped.background },
    control: { height: 44, flexDirection: 'row', borderRadius: 22, backgroundColor: theme.colors.surfaceHigh },
}));
