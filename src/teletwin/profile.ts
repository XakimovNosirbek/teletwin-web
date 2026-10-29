// Server profile fields of corp employees (title, department, phone, birthday, working hours) from `GET /employees`
import type { CorpEmployeeInfo } from './api';

import { createSignal } from '../util/signals';

const [getCorpProfiles, setCorpProfilesById] = createSignal<Record<number, CorpEmployeeInfo>>({});
const [getMyProfileOpen, setMyProfileOpen] = createSignal(false);

export { getCorpProfiles, getMyProfileOpen, setMyProfileOpen };

export function setCorpProfiles(employees: CorpEmployeeInfo[]) {
  setCorpProfilesById(Object.fromEntries(employees.map((employee) => [employee.id, employee])));
}

export function updateCorpProfile(employee: CorpEmployeeInfo) {
  setCorpProfilesById({ ...getCorpProfiles(), [employee.id]: { ...getCorpProfiles()[employee.id], ...employee } });
}

export function clearCorpProfiles() {
  setCorpProfilesById({});
}
