/* eslint-disable @typescript-eslint/no-non-null-assertion */
import { Cookie, CookieJar } from 'tough-cookie';

export type { Cookie } from 'tough-cookie';
export type Cookies = Cookie.Serialized[];

export const proxyUrl = 'https://proxy.xhr.dev';
// export const proxyUrl = 'http://localhost:8001'; # for when @skilbjo is testing

export const getCsrfCookieFromJar = ({
  cookieName,
  jar,
}: {
  cookieName: 'CSRF_TOKEN' | 'X-CSRF-TOKEN' | 'XSRF-TOKEN';
  jar: CookieJar;
}): Cookie.Serialized | undefined =>
  jar
    .serializeSync()!
    .cookies // transform cookies from jar->puppeteer format, since data portion is implemented in pupppeteer
    .find(({ key }) => key === cookieName);

const getJarFromCookies = ({ cookies }: { cookies: Cookies }): CookieJar => {
  const jar = new CookieJar(undefined, {
    // https://github.com/salesforce/tough-cookie/tree/master?tab=readme-ov-file#cookiejar
    rejectPublicSuffixes: false,
  });

  cookies.forEach((cookie) =>
    jar.setCookieSync(
      Cookie.fromJSON(JSON.stringify(cookie))!,
      `https://${cookie.domain}`
    )
  );

  return jar;
};

export const createJar = ({ cookies }: { cookies: Cookies }): CookieJar =>
  getJarFromCookies({
    cookies: cookies.map((c: Cookies[number]) => ({
      ...c,
      ...(c['expires']
        ? {
            expires: new Date(
              ((c['expires'] as unknown as number) || new Date().getTime()) *
                1000
            ).toISOString(),
          }
        : null),
      key: (c as any).name || (c as any).key, // eslint-disable-line @typescript-eslint/no-explicit-any
    })) as unknown as Cookies,
  });

const stringifyCookies = ({ cookies }: { cookies: Cookies }) =>
  JSON.stringify(
    cookies.map((c) => ({
      ...c,
      ...(c.expires
        ? { expires: new Date(c['expires']).getTime() / 1000 }
        : null),
      name: c['key'],
    }))
  )
    .replace(/\\"/g, '')
    .replace(/\\/g, '');

export const stringifyCookiesFromJar = ({ jar }: { jar: CookieJar }): string =>
  stringifyCookies({
    cookies: jar.serializeSync()!.cookies,
  });
