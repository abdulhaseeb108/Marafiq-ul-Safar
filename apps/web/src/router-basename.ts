export function resolveRouterBasename(pathname = window.location.pathname) {
  const normalizedPath = pathname === '/' ? '/' : pathname.replace(/\/+$/, '');
  const isMarafiqPath = normalizedPath === '/marafiq' || normalizedPath.startsWith('/marafiq/');
  return isMarafiqPath ? '/marafiq' : '/';
}
