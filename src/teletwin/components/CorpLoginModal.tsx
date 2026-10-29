import type { ChangeEvent, FormEvent } from 'react';
import { memo, useState } from '../../lib/teact/teact';

import type { CorpLoginError } from '../index';

import {
  DEFAULT_CORP_SERVER, getIsCorpLoginOpen, loginToCorp, setIsCorpLoginOpen,
} from '../index';

import useDerivedState from '../../hooks/useDerivedState';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import InputText from '../../components/ui/InputText';
import Modal from '../../components/ui/Modal';

import styles from './CorpLoginModal.module.scss';

// Company login: a separate session on the TeleTwin server, next to the Telegram account
const CorpLoginModal = () => {
  const lang = useLang();
  const isOpen = useDerivedState(getIsCorpLoginOpen);
  const [server, setServer] = useState(DEFAULT_CORP_SERVER);
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<CorpLoginError | undefined>();
  const [isLoading, markLoading, unmarkLoading] = useFlag();

  const canSubmit = Boolean(server.trim() && login.trim() && password) && !isLoading;

  const handleServerChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setServer(e.target.value);
    setError(undefined);
  });

  const handleLoginChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setLogin(e.target.value);
    setError(undefined);
  });

  const handlePasswordChange = useLastCallback((e: ChangeEvent<HTMLInputElement>) => {
    setPassword(e.target.value);
    setError(undefined);
  });

  const handleClose = useLastCallback(() => {
    setIsCorpLoginOpen(false);
    setPassword('');
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    markLoading();
    const loginError = await loginToCorp(server, login, password);
    unmarkLoading();

    if (loginError) {
      setError(loginError);
      return;
    }

    handleClose();
  });

  return (
    <Modal
      className={styles.root}
      title={lang('TeleTwinLoginTitle')}
      isOpen={isOpen}
      hasCloseButton
      onClose={handleClose}
    >
      <form className={styles.form} onSubmit={handleSubmit}>
        <InputText
          id="teletwin-server"
          label={lang('TeleTwinServer')}
          value={server}
          inputMode="url"
          onChange={handleServerChange}
        />
        <InputText
          id="teletwin-login"
          label={lang('TeleTwinLogin')}
          value={login}
          autoComplete="username"
          autoFocus
          onChange={handleLoginChange}
        />
        <div className={`input-group with-label${password ? ' touched' : ''}`}>
          <input
            id="teletwin-password"
            className="form-control"
            type="password"
            value={password}
            autoComplete="current-password"
            aria-label={lang('TeleTwinPassword')}
            onChange={handlePasswordChange}
          />
          <label htmlFor="teletwin-password">{lang('TeleTwinPassword')}</label>
        </div>
        {error && <p className={styles.error} role="alert">{lang(error)}</p>}
        <div className="dialog-buttons">
          <Button type="submit" isText inline isLoading={isLoading} disabled={!canSubmit}>
            {lang('TeleTwinSignIn')}
          </Button>
          <Button isText inline onClick={handleClose}>
            {lang('TeleTwinCancel')}
          </Button>
        </div>
      </form>
    </Modal>
  );
};

export default memo(CorpLoginModal);
