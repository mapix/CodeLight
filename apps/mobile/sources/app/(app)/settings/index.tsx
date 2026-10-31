import { SettingsView } from "@/components/SettingsView";
import { MOBILE_GLASS_HEADER_HEIGHT } from '@/components/navigation/headerMetrics';
import { Platform } from 'react-native';
import { config } from '@/config';
import { Redirect } from 'expo-router';

export default function SettingsScreen() {
    if (config.noninvasiveLocal) return <Redirect href="/" />;
    return (
        <SettingsView
            topContentInset={Platform.OS === 'ios' ? MOBILE_GLASS_HEADER_HEIGHT : 0}
        />
    );
}
