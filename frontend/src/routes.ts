import { id } from './api';
export interface Route {
  labId?: string;
  tab: string;
  teamId?: string;
  exerciseId?: string;
}
export function parseRoute(hash: string): Route {
  const parts = hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts[0] !== 'labs' || !parts[1]) return { tab: 'overview' };
    const labId = decodeURIComponent(parts[1]);
    const tab = ['exercises', 'teams', 'materials'].includes(parts[2]) ? parts[2] : 'overview';
    return {
      labId,
      tab,
      teamId: tab === 'teams' && parts[3] ? decodeURIComponent(parts[3]) : undefined,
      exerciseId:
        tab === 'teams' && parts[4] === 'exercises' && parts[5]
          ? decodeURIComponent(parts[5])
          : undefined,
    };
  } catch {
    return { tab: 'overview' };
  }
}
export function routeHash(route: Route) {
  if (!route.labId) return '';
  return `#/labs/${id(route.labId)}/${route.tab}${route.tab === 'teams' && route.teamId ? `/${id(route.teamId)}${route.exerciseId ? `/exercises/${id(route.exerciseId)}` : ''}` : ''}`;
}
