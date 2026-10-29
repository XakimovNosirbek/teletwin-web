import { memo } from '../../lib/teact/teact';

import { getCorpCredentials, logoutFromCorp, setIsCorpLoginOpen } from '../index';

import useDerivedState from '../../hooks/useDerivedState';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import MenuItem from '../../components/ui/MenuItem';
import NestedMenuItem from '../../components/ui/NestedMenuItem';

const RE_URL_SCHEME = /^https?:\/\//;
const RE_TRAILING_SLASH = /\/$/;

// "Korxona" entry of the left main menu: opens the corp login, or shows the corp session with "Chiqish"
const CorpMenuItem = () => {
  const lang = useLang();
  const credentials = useDerivedState(getCorpCredentials);

  const handleOpenLogin = useLastCallback(() => {
    setIsCorpLoginOpen(true);
  });

  const handleLogout = useLastCallback(() => {
    logoutFromCorp();
  });

  if (!credentials) {
    return (
      <MenuItem icon="folder" onClick={handleOpenLogin}>
        {lang('TeleTwinMenuItem')}
      </MenuItem>
    );
  }

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
