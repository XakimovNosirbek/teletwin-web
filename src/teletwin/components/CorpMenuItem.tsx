import { memo, useEffect } from '../../lib/teact/teact';

import {
  getActivitySeenAt, getCorpActivity, getCorpActivityUnreadCount, loadCorpActivity, setActivityModalOpen,
} from '../activity';
import { getCorpCredentials, logoutFromCorp, setDirectPickerOpen } from '../index';
import { setMyProfileOpen } from '../profile';
import { setSavedModalOpen } from '../saved';
import { setStatusModalOpen } from '../status';
import { getIsWakeUpMuted, toggleWakeUpSound } from '../wakeup';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import MenuItem from '../../components/ui/MenuItem';
import NestedMenuItem from '../../components/ui/NestedMenuItem';

import styles from './CorpPanels.module.scss';

const RE_URL_SCHEME = /^https?:\/\//;
const RE_TRAILING_SLASH = /\/$/;

// "Korxona" entry of the left main menu: the corp session, "Xodimga yozish", "Holatim", the wake-up sound switch and
// "Chiqish"
const CorpMenuItem = () => {
  const lang = useLang();
  const credentials = useDerivedState(getCorpCredentials);
  const isWakeUpMuted = useDerivedState(getIsWakeUpMuted);
  useDerivedState(getCorpActivity);
  useDerivedState(getActivitySeenAt);
  const activityUnread = getCorpActivityUnreadCount();

  // The menu is rendered when the main menu opens: a fresh unread count for "Faollik"
  useEffect(() => {
    if (credentials) void loadCorpActivity();
  }, [credentials]);

  const handleLogout = useLastCallback(() => {
    logoutFromCorp();
  });

  const handleWriteToEmployee = useLastCallback(() => {
    setDirectPickerOpen(true);
  });

  const handleOpenStatus = useLastCallback(() => {
    setStatusModalOpen(true);
  });

  const handleToggleSound = useLastCallback(() => {
    toggleWakeUpSound();
  });

  if (!credentials) return undefined;

  const { employee, server } = credentials;

  return (
    <NestedMenuItem
      icon="folder"
      submenu={(
        <>
          <MenuItem icon="user" disabled withWrap>
            {`${employee.fullName} (${employee.login})`}
          </MenuItem>
          <MenuItem icon="web" disabled withWrap>
            {server.replace(RE_URL_SCHEME, '').replace(RE_TRAILING_SLASH, '')}
          </MenuItem>
          <MenuItem icon="new-chat-filled" onClick={handleWriteToEmployee}>
            {lang('TeleTwinDirectPick')}
          </MenuItem>
          <MenuItem icon="user" onClick={() => setMyProfileOpen(true)}>
            {lang('TeleTwinMyProfile')}
          </MenuItem>
          <MenuItem icon="smile" onClick={handleOpenStatus}>
            {lang('TeleTwinMyStatus')}
          </MenuItem>
          <MenuItem icon="mention" onClick={() => setActivityModalOpen(true)}>
            {lang('TeleTwinActivityTitle')}
            {activityUnread > 0 && <span className={styles.badge} data-corp-activity-badge>{activityUnread}</span>}
          </MenuItem>
          <MenuItem icon="saved-messages" onClick={() => setSavedModalOpen(true)}>
            {lang('TeleTwinSavedTitle')}
          </MenuItem>
          <MenuItem icon={isWakeUpMuted ? 'mute' : 'unmute'} onClick={handleToggleSound}>
            {lang('TeleTwinWakeUpSound')}
          </MenuItem>
          <MenuItem icon="logout" destructive onClick={handleLogout}>
            {lang('TeleTwinLogOut')}
          </MenuItem>
        </>
      )}
    >
      {lang('TeleTwinMenuItem')}
    </NestedMenuItem>
  );
};

export default memo(CorpMenuItem);
