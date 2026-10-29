import type { ChangeEvent, FormEvent } from 'react';
import { memo, useState } from '../../lib/teact/teact';

import type { CorpLoginError, CorpRegisterError } from '../index';

import buildClassName from '../../util/buildClassName';
import {
  cancelPendingRegistration, DEFAULT_CORP_SERVER, getCorpCredentials, getCorpTelegramUserId,
  getPendingRegistration, getRegistrationError, loginToCorp, logoutFromTelegram, registerInCorp,
} from '../index';

import useDerivedState from '../../hooks/useDerivedState';
import useFlag from '../../hooks/useFlag';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../../components/ui/Button';
import InputText from '../../components/ui/InputText';
import Spinner from '../../components/ui/Spinner';

import styles from './CorpGate.module.scss';

type Mode = 'login' | 'register';
type GateError = CorpLoginError | CorpRegisterError | 'TeleTwinErrorPasswordMismatch' | 'TeleTwinErrorPasswordShort';

const PASSWORD_MIN_LENGTH = 8;

// Blocks the whole app until the Telegram account is linked to an approved corp account
const CorpGate = () => {
  const lang = useLang();
  const telegramUserId = useDerivedState(getCorpTelegramUserId);
  const credentials = useDerivedState(getCorpCredentials);
  const pending = useDerivedState(getPendingRegistration);
  const registrationError = useDerivedState(getRegistrationError);

  const [mode, setMode] = useState<Mode>('login');
  const [server, setServer] = useState(DEFAULT_CORP_SERVER);
  const [fullName, setFullName] = useState('');
  const [login, setLogin] = useState('');
  const [password, setPassword] = useState('');
  const [passwordRepeat, setPasswordRepeat] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState<GateError | undefined>();
  const [isLoading, markLoading, unmarkLoading] = useFlag();

  const isRegister = mode === 'register';
  const canSubmit = Boolean(server.trim() && login.trim() && password) && !isLoading
    && (!isRegister || Boolean(fullName.trim() && passwordRepeat));

  const handleChange = useLastCallback((setter: (value: string) => void) => (e: ChangeEvent<HTMLInputElement>) => {
    setter(e.target.value);
    setError(undefined);
  });

  const handleModeChange = useLastCallback((newMode: Mode) => {
    setMode(newMode);
    setError(undefined);
  });

  const handleSubmit = useLastCallback(async (e: FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;

    if (isRegister) {
      if (password.length < PASSWORD_MIN_LENGTH) {
        setError('TeleTwinErrorPasswordShort');
        return;
      }
      if (password !== passwordRepeat) {
        setError('TeleTwinErrorPasswordMismatch');
        return;
      }
    }

    markLoading();
    const submitError = isRegister
      ? await registerInCorp(server, {
        fullName, login, password, note,
      })
      : await loginToCorp(server, login, password);
    unmarkLoading();

    if (submitError && submitError !== 'TeleTwinPending') {
      setError(submitError);
      return;
    }

    setPassword('');
    setPasswordRepeat('');
  });

  const handleBack = useLastCallback(() => {
    cancelPendingRegistration();
  });

  const handleTelegramLogout = useLastCallback(() => {
    logoutFromTelegram();
  });

  if (!telegramUserId || credentials) return undefined;

  function renderPassword(
    id: string, value: string, label: string, onChange: (e: ChangeEvent<HTMLInputElement>) => void,
  ) {
    return (
      <div className={buildClassName('input-group with-label', value && 'touched')}>
        <input
          id={id}
          className="form-control"
          type="password"
          value={value}
          autoComplete={isRegister ? 'new-password' : 'current-password'}
          aria-label={label}
          onChange={onChange}
        />
        <label htmlFor={id}>{label}</label>
      </div>
    );
  }

  function renderPending() {
    return (
      <div className={styles.pending}>
        <Spinner className={styles.spinner} />
        <p className={styles.pendingText}>{lang('TeleTwinPending')}</p>
        <Button isText onClick={handleBack}>{lang('TeleTwinBack')}</Button>
      </div>
    );
  }

  function renderForm() {
    const shownError = error || registrationError;

    return (
      <>
        <div className={styles.tabs} role="tablist">
          <button
            type="button"
            role="tab"
            aria-selected={!isRegister}
            className={buildClassName(styles.tab, !isRegister && styles.tabActive)}
            onClick={() => handleModeChange('login')}
          >
            {lang('TeleTwinSignIn')}
          </button>
          <button
            type="button"
            role="tab"
            aria-selected={isRegister}
            className={buildClassName(styles.tab, isRegister && styles.tabActive)}
            onClick={() => handleModeChange('register')}
          >
            {lang('TeleTwinTabRegister')}
          </button>
        </div>
        <form className={styles.form} onSubmit={handleSubmit}>
          <InputText
            id="teletwin-server"
            label={lang('TeleTwinServer')}
            value={server}
            inputMode="url"
            onChange={handleChange(setServer)}
          />
          {isRegister && (
            <InputText
              id="teletwin-full-name"
              label={lang('TeleTwinFullName')}
              value={fullName}
              autoComplete="name"
              onChange={handleChange(setFullName)}
            />
          )}
          <InputText
            id="teletwin-login"
            label={lang('TeleTwinLogin')}
            value={login}
            autoComplete="username"
            onChange={handleChange(setLogin)}
          />
          {renderPassword('teletwin-password', password, lang('TeleTwinPassword'), handleChange(setPassword))}
          {isRegister && renderPassword(
            'teletwin-password-repeat', passwordRepeat, lang('TeleTwinPasswordRepeat'), handleChange(setPasswordRepeat),
          )}
          {isRegister && (
            <InputText
              id="teletwin-note"
              label={lang('TeleTwinNote')}
              value={note}
              onChange={handleChange(setNote)}
            />
          )}
          {shownError && <p className={styles.error} role="alert">{lang(shownError)}</p>}
          <Button type="submit" isLoading={isLoading} disabled={!canSubmit}>
            {lang(isRegister ? 'TeleTwinRegister' : 'TeleTwinSignIn')}
          </Button>
        </form>
      </>
    );
  }

  return (
    <div className={styles.root} role="dialog" aria-modal="true">
      <div className={styles.card}>
        <h1 className={styles.title}>{lang('TeleTwinFolderTitle')}</h1>
        <p className={styles.subtitle}>{lang('TeleTwinGateSubtitle')}</p>
        {pending ? renderPending() : renderForm()}
        <Button className={styles.telegramLogout} isText color="danger" onClick={handleTelegramLogout}>
          {lang('TeleTwinTelegramLogOut')}
        </Button>
      </div>
    </div>
  );
};

export default memo(CorpGate);
