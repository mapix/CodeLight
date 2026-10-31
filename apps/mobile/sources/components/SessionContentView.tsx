import React from 'react';
import { View } from 'react-native';
import { AgentContentView } from './AgentContentView';

type Props = React.ComponentProps<typeof AgentContentView> & { windowMode: boolean; sourceActivationRequired?: boolean };

export function SessionContentView({ windowMode, sourceActivationRequired = false, ...chat }: Props) {
    // 真窗口没有聊天消息；通用空状态 overlay 和 composer 会遮住 Open，必须在渲染所有者处排除整个聊天 surface。
    return windowMode
        ? <View testID="codelight-window-content" style={{ flex: 1 }}>{chat.content}</View>
        // 首次原生来源尚未订阅历史时也没有消息；不能让 empty overlay 遮住唯一的激活入口。
        : <AgentContentView {...chat} placeholder={sourceActivationRequired ? null : chat.placeholder} />;
}
