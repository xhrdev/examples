/* eslint-disable @typescript-eslint/no-non-null-assertion */
import type { CookieJar, SerializedCookie } from 'tough-cookie';

export const getCsrfCookieFromJar = ({
  cookieName,
  jar,
}: {
  cookieName: 'CSRF_TOKEN' | 'X-CSRF-TOKEN' | 'XSRF-TOKEN';
  jar: CookieJar;
}): SerializedCookie | undefined =>
  jar
    .serializeSync()!
    .cookies // transform cookies from jar->puppeteer format, since data portion is implemented in pupppeteer
    .find(({ key }) => key === cookieName);
