import { Appearance, Platform } from 'react-native';
import { UnistylesRuntime } from 'react-native-unistyles';
import * as SystemUI from 'expo-system-ui';
import { darkTheme, lightTheme } from '@/theme';

export type AppThemePreference = 'adaptive' | 'light' | 'dark';
/** Applies an existing local preference; persistence remains owned by the settings store. */
export function applyAppThemePreference(preference: AppThemePreference) {
    if (Platform.OS !== 'web') Appearance.setColorScheme(preference === 'adaptive' ? 'unspecified' : preference);
    UnistylesRuntime.setAdaptiveThemes(preference === 'adaptive');
    if (preference !== 'adaptive') UnistylesRuntime.setTheme(preference);
    const dark = preference === 'dark' || preference === 'adaptive' && Appearance.getColorScheme() === 'dark';
    const color = (dark ? darkTheme : lightTheme).colors.groupped.background;
    UnistylesRuntime.setRootViewBackgroundColor(color);
    void SystemUI.setBackgroundColorAsync(color);
}
