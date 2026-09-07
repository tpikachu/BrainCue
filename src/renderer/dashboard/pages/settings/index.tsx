import type React from 'react';
import { useEffect } from 'react';
import { Navigate, useParams } from 'react-router-dom';
import { useSettingsStore } from '../../../store/useSettingsStore';
import { SettingsLayout } from './SettingsLayout';
import { PreferencesPanel } from './PreferencesPanel';
import { HotkeysPanel } from './HotkeysPanel';
import { SpeechPanel } from './SpeechPanel';
import { ModelsPanel } from './ModelsPanel';
import { PrivacyPanel } from './PrivacyPanel';
import { SystemPanel } from './SystemPanel';
import {
  DEFAULT_SETTINGS_SECTION,
  isSettingsSection,
  settingsPath,
  type SettingsSectionId,
} from './sections';

/** Section id → panel. `sections.test.ts` asserts this covers the catalog. */
export const PANELS: Record<SettingsSectionId, React.ComponentType> = {
  preferences: PreferencesPanel,
  hotkeys: HotkeysPanel,
  speech: SpeechPanel,
  models: ModelsPanel,
  privacy: PrivacyPanel,
  system: SystemPanel,
};

/**
 * `/settings/:section`. `/settings` and any unknown section land on the first
 * one, so every old deep-link (the tray, Help, the "add it in Settings" links)
 * still opens something.
 */
export default function SettingsPage() {
  const { section } = useParams<{ section: string }>();
  const load = useSettingsStore((s) => s.load);

  // Every panel reads the shared store; load it once per visit rather than
  // once per panel, so switching sections does not refetch.
  useEffect(() => {
    void load();
  }, [load]);

  if (!isSettingsSection(section)) {
    return <Navigate to={settingsPath(DEFAULT_SETTINGS_SECTION)} replace />;
  }
  const Panel = PANELS[section];
  return (
    <SettingsLayout>
      <Panel key={section} />
    </SettingsLayout>
  );
}
