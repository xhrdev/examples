/**
 * run this script:

npm run tsx src/mr007.ts

 */
import axios from 'axios';
import { CookieJar } from 'tough-cookie';
import { wrapper } from 'axios-cookiejar-support';
import { chromium } from 'playwright';

wrapper(axios);

const jar = new CookieJar();

type Mr077Response = {
  cookie_string: string;
  cookies_dict: { [key: string]: string };
  cookies_list: {
    domain: string;
    name: string;
    value: string;
  }[];
  datadome_value: null | string;
  domain: string;
  error: null | string;
  message: string;
  status: number;
  title: string;
};
type Site = 'costco' | 'grainger';

const mr007 = async ({
  site,
}: {
  site: Site;
}): Promise<Mr077Response['cookies_list']> => {
  console.log({ site });

  const url =
    site === 'costco'
      ? 'https://operantly-showiest-kittie.ngrok-free.dev/get-cookies?x_api_key=9KWUP2TUOO26TSW6P9A3&domain=https://www.costco.com/'
      : 'https://operantly-showiest-kittie.ngrok-free.dev/get-datadome-grainger?x_api_key=9KWUP2TUOO26TSW6P9A3';

  const {
    data: { cookies_list: cookieList },
  } = await axios.request<Mr077Response>({
    headers: {
      'ngrok-skip-browser-warning': 'skip',
    },
    url,
  });

  return cookieList;

  /*
  return {
    cookie_string:
      '_abck=76C7617FFBF218676EEA5A6F48433D07~-1~YAAQExzFF0YnkgmcAQAAvsnDGA+nO0NuRDrRVtM8xQRV6nUtH6ZlwJJSSyXn54c0gEwoEzBv/FncEATq+slOhWlbevKPjupGS7VYPLpuB4omiiT+MSscjsUqUV3djN7UBc2J7cfpT5IO8xPVQuSKyqPjGgmghEksFP6ypzlrfpJBFNhRLyr8um9vzPiE8/M2Gwwds49MdFw5RpgBVWYevcCVqjCOKcmERJrycieUE/IzabZrvHW4/rlhN7nlVA3ehOQPP+Y1Cb6bEja4MQEQGXPPMJc0B/LjrjfR8Kbe4UBset/HPSkOuAqpBjIByAO2SViNwR6qpvBnTOa2AArxGoF/g2RH0NBbL30KFavje2yp10KPbjDW9LXgHxtgTeeieDQqys21G0s1cuVyfbwwkwg/A1gas6a+ZqU1Jh18/0yLmQpgXZJ1DtJ1xfIZk+NGD3Dfyg5dj/UnigVTriC7fRdncWAs6Nf94cxKmlt3Z81xYjJO9boSPSV3qV+Nqdsvd6I2HkkpWO5VNrkuWSEfO9FvE4X5SHXINwkCAbLyzbWIfvTUPJwRzHPPYjByfyUB8qT/FsoPqm6YHqwYwZG4hzg=~-1~-1~1769945608~AAQAAAAF%2f%2f%2f%2f%2f9jCuE1QPqVHIlPdJ6RAAILuJFbxBl5tAnR49AL4jtE+E5%2f3DCu8Vhp4WEHN1T+ZFRJmIBoNE5jEGXaEVkOuOm0QOEW+qkgQl0Bm~-1; akavpau_zezxapz5yf=1769942310~id=6cd4681225ec5d2562d2ffdaf7b4eeee; _lr_tabs_-costco%2Fproduction-vrwno={%22recordingID%22:%226-019c18c3-c4f9-7ca9-80d7-41fcfa21396b%22%2C%22sessionID%22:0%2C%22lastActivity%22:1769942013926%2C%22hasActivity%22:false%2C%22clearsIdentifiedUser%22:false%2C%22confirmed%22:false}; bm_sz=B4029029353B930FECF002A7A9D6E5C2~YAAQExzFF/0ekgmcAQAABbjDGB7U9uUHv7E40UmKi4PHXjBdlc0nk+/3z1xOqiNlcK0FhQvGAtIUcvM4SEASWJ0UqQ+s9p0LaHgnYhda9WpDdQRTPJD2Yizq8VbBVpqoVJSTrWpOfLUHb5WiVyJ/dTWCo5ZFcoV2yeyEHhJfED6syxOlKPh3UNMPcu8y80Sk/ezh1rEnP1lWpPBsr0jr7QyF7pzB/8pdPoYpbTcKnK55zTWa6QHFnK9c17fr2lMW5HV0zBEge59dm8tJTD9DVQPf97womv+Opyj126CA6i0ebYvKySdjJ315oWDEsQ7jzSnXvVGUnJdBEdRdJF4D6e1xm+etisDi7sUc8C82TCrOEHNztB9/5wlvh2J9aXGpCR/WwIUF+f8OHQn+~3290420~4405316; bm_lso=177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=~1769942008793; BCO=pm3; bm_so=177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=; bm_s=YAAQExzFF/sekgmcAQAABbjDGASAIan3QSH7hSQQ/kmmvWRakxmKQ0hj9WxuZy4liDCiVe7Zm/Prg6yDs732ON6hcBZEScRHrGK4lzCUi1OzALxhSw1MBMts8UQrOYxUkY6yE+Exqo6LXGIvOE6SFgJX5DT/1vsILXUGeo0HMoykoD+Y+zXokAH7iJ0+h0L/0Dj+gwVHbk968BFlSOy3YkuYCuD3wbOedh5wLo+ivfqiIp/zIiV5aTeO/v2ZhJ77XqRSJlBIIpB3bJyDreoci/H3XO9xNPhNuLPla+9RJ42nt5xg8HeFUp6yMB8RGlpamw56DqMEzjI2OImBO1uFii8DyfsjL+0hRjBk1dN5+mYTYOfIY8ugaRw4nFw22d7+BQRcUWG07bhsdL9gzC4ZGna721JYewxbIH/5Zv9aBYDzRZAZZJgXnBUdClYJJnkOv0zRFy692lrH2m8GfOpP1g+Am0Mvh6vaaQO4OyPAgDJGHgmDAg3rCbQgi2LSc5ephRW98BwIPaGSGTsyEditzkqJ1Wvlgw1E3eK6u3HeBSTsi04qlLNXpkU1MavVSccI; RT="z=1&dm=www.costco.com&si=38eb67c1-e49f-49a3-bd25-41f837b60f02&ss=ml3lrqsr&sl=1&tt=44l&bcn=%2F%2F684d0d49.akstat.io%2F&ld=44z"; bm_ss=ab8e18ef4e; akaas_AS01=2147483647~rv=60~id=83e6874e2e487202ec44a0d07268f8e6; _lr_hb_-costco%2Fproduction-vrwno={%22heartbeat%22:1769942009675}; AKA_A2=A',
    cookies_dict: {
      _abck:
        '76C7617FFBF218676EEA5A6F48433D07~-1~YAAQExzFF0YnkgmcAQAAvsnDGA+nO0NuRDrRVtM8xQRV6nUtH6ZlwJJSSyXn54c0gEwoEzBv/FncEATq+slOhWlbevKPjupGS7VYPLpuB4omiiT+MSscjsUqUV3djN7UBc2J7cfpT5IO8xPVQuSKyqPjGgmghEksFP6ypzlrfpJBFNhRLyr8um9vzPiE8/M2Gwwds49MdFw5RpgBVWYevcCVqjCOKcmERJrycieUE/IzabZrvHW4/rlhN7nlVA3ehOQPP+Y1Cb6bEja4MQEQGXPPMJc0B/LjrjfR8Kbe4UBset/HPSkOuAqpBjIByAO2SViNwR6qpvBnTOa2AArxGoF/g2RH0NBbL30KFavje2yp10KPbjDW9LXgHxtgTeeieDQqys21G0s1cuVyfbwwkwg/A1gas6a+ZqU1Jh18/0yLmQpgXZJ1DtJ1xfIZk+NGD3Dfyg5dj/UnigVTriC7fRdncWAs6Nf94cxKmlt3Z81xYjJO9boSPSV3qV+Nqdsvd6I2HkkpWO5VNrkuWSEfO9FvE4X5SHXINwkCAbLyzbWIfvTUPJwRzHPPYjByfyUB8qT/FsoPqm6YHqwYwZG4hzg=~-1~-1~1769945608~AAQAAAAF%2f%2f%2f%2f%2f9jCuE1QPqVHIlPdJ6RAAILuJFbxBl5tAnR49AL4jtE+E5%2f3DCu8Vhp4WEHN1T+ZFRJmIBoNE5jEGXaEVkOuOm0QOEW+qkgQl0Bm~-1',
      '_lr_hb_-costco%2Fproduction-vrwno': '{%22heartbeat%22:1769942009675}',
      '_lr_tabs_-costco%2Fproduction-vrwno':
        '{%22recordingID%22:%226-019c18c3-c4f9-7ca9-80d7-41fcfa21396b%22%2C%22sessionID%22:0%2C%22lastActivity%22:1769942013926%2C%22hasActivity%22:false%2C%22clearsIdentifiedUser%22:false%2C%22confirmed%22:false}',
      AKA_A2: 'A',
      akaas_AS01: '2147483647~rv=60~id=83e6874e2e487202ec44a0d07268f8e6',
      akavpau_zezxapz5yf: '1769942310~id=6cd4681225ec5d2562d2ffdaf7b4eeee',
      BCO: 'pm3',
      bm_lso:
        '177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=~1769942008793',
      bm_s: 'YAAQExzFF/sekgmcAQAABbjDGASAIan3QSH7hSQQ/kmmvWRakxmKQ0hj9WxuZy4liDCiVe7Zm/Prg6yDs732ON6hcBZEScRHrGK4lzCUi1OzALxhSw1MBMts8UQrOYxUkY6yE+Exqo6LXGIvOE6SFgJX5DT/1vsILXUGeo0HMoykoD+Y+zXokAH7iJ0+h0L/0Dj+gwVHbk968BFlSOy3YkuYCuD3wbOedh5wLo+ivfqiIp/zIiV5aTeO/v2ZhJ77XqRSJlBIIpB3bJyDreoci/H3XO9xNPhNuLPla+9RJ42nt5xg8HeFUp6yMB8RGlpamw56DqMEzjI2OImBO1uFii8DyfsjL+0hRjBk1dN5+mYTYOfIY8ugaRw4nFw22d7+BQRcUWG07bhsdL9gzC4ZGna721JYewxbIH/5Zv9aBYDzRZAZZJgXnBUdClYJJnkOv0zRFy692lrH2m8GfOpP1g+Am0Mvh6vaaQO4OyPAgDJGHgmDAg3rCbQgi2LSc5ephRW98BwIPaGSGTsyEditzkqJ1Wvlgw1E3eK6u3HeBSTsi04qlLNXpkU1MavVSccI',
      bm_so:
        '177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=',
      bm_ss: 'ab8e18ef4e',
      bm_sz:
        'B4029029353B930FECF002A7A9D6E5C2~YAAQExzFF/0ekgmcAQAABbjDGB7U9uUHv7E40UmKi4PHXjBdlc0nk+/3z1xOqiNlcK0FhQvGAtIUcvM4SEASWJ0UqQ+s9p0LaHgnYhda9WpDdQRTPJD2Yizq8VbBVpqoVJSTrWpOfLUHb5WiVyJ/dTWCo5ZFcoV2yeyEHhJfED6syxOlKPh3UNMPcu8y80Sk/ezh1rEnP1lWpPBsr0jr7QyF7pzB/8pdPoYpbTcKnK55zTWa6QHFnK9c17fr2lMW5HV0zBEge59dm8tJTD9DVQPf97womv+Opyj126CA6i0ebYvKySdjJ315oWDEsQ7jzSnXvVGUnJdBEdRdJF4D6e1xm+etisDi7sUc8C82TCrOEHNztB9/5wlvh2J9aXGpCR/WwIUF+f8OHQn+~3290420~4405316',
      RT: '"z=1&dm=www.costco.com&si=38eb67c1-e49f-49a3-bd25-41f837b60f02&ss=ml3lrqsr&sl=1&tt=44l&bcn=%2F%2F684d0d49.akstat.io%2F&ld=44z"',
    },
    cookies_list: [
      {
        domain: '.costco.com',
        name: '_abck',
        value:
          '76C7617FFBF218676EEA5A6F48433D07~-1~YAAQExzFF0YnkgmcAQAAvsnDGA+nO0NuRDrRVtM8xQRV6nUtH6ZlwJJSSyXn54c0gEwoEzBv/FncEATq+slOhWlbevKPjupGS7VYPLpuB4omiiT+MSscjsUqUV3djN7UBc2J7cfpT5IO8xPVQuSKyqPjGgmghEksFP6ypzlrfpJBFNhRLyr8um9vzPiE8/M2Gwwds49MdFw5RpgBVWYevcCVqjCOKcmERJrycieUE/IzabZrvHW4/rlhN7nlVA3ehOQPP+Y1Cb6bEja4MQEQGXPPMJc0B/LjrjfR8Kbe4UBset/HPSkOuAqpBjIByAO2SViNwR6qpvBnTOa2AArxGoF/g2RH0NBbL30KFavje2yp10KPbjDW9LXgHxtgTeeieDQqys21G0s1cuVyfbwwkwg/A1gas6a+ZqU1Jh18/0yLmQpgXZJ1DtJ1xfIZk+NGD3Dfyg5dj/UnigVTriC7fRdncWAs6Nf94cxKmlt3Z81xYjJO9boSPSV3qV+Nqdsvd6I2HkkpWO5VNrkuWSEfO9FvE4X5SHXINwkCAbLyzbWIfvTUPJwRzHPPYjByfyUB8qT/FsoPqm6YHqwYwZG4hzg=~-1~-1~1769945608~AAQAAAAF%2f%2f%2f%2f%2f9jCuE1QPqVHIlPdJ6RAAILuJFbxBl5tAnR49AL4jtE+E5%2f3DCu8Vhp4WEHN1T+ZFRJmIBoNE5jEGXaEVkOuOm0QOEW+qkgQl0Bm~-1',
      },
      {
        domain: '.www.costco.com',
        name: 'akavpau_zezxapz5yf',
        value: '1769942310~id=6cd4681225ec5d2562d2ffdaf7b4eeee',
      },
      {
        domain: 'www.costco.com',
        name: '_lr_tabs_-costco%2Fproduction-vrwno',
        value:
          '{%22recordingID%22:%226-019c18c3-c4f9-7ca9-80d7-41fcfa21396b%22%2C%22sessionID%22:0%2C%22lastActivity%22:1769942013926%2C%22hasActivity%22:false%2C%22clearsIdentifiedUser%22:false%2C%22confirmed%22:false}',
      },
      {
        domain: '.costco.com',
        name: 'bm_sz',
        value:
          'B4029029353B930FECF002A7A9D6E5C2~YAAQExzFF/0ekgmcAQAABbjDGB7U9uUHv7E40UmKi4PHXjBdlc0nk+/3z1xOqiNlcK0FhQvGAtIUcvM4SEASWJ0UqQ+s9p0LaHgnYhda9WpDdQRTPJD2Yizq8VbBVpqoVJSTrWpOfLUHb5WiVyJ/dTWCo5ZFcoV2yeyEHhJfED6syxOlKPh3UNMPcu8y80Sk/ezh1rEnP1lWpPBsr0jr7QyF7pzB/8pdPoYpbTcKnK55zTWa6QHFnK9c17fr2lMW5HV0zBEge59dm8tJTD9DVQPf97womv+Opyj126CA6i0ebYvKySdjJ315oWDEsQ7jzSnXvVGUnJdBEdRdJF4D6e1xm+etisDi7sUc8C82TCrOEHNztB9/5wlvh2J9aXGpCR/WwIUF+f8OHQn+~3290420~4405316',
      },
      {
        domain: '.www.costco.com',
        name: 'bm_lso',
        value:
          '177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=~1769942008793',
      },
      {
        domain: '.costco.com',
        name: 'BCO',
        value: 'pm3',
      },
      {
        domain: '.costco.com',
        name: 'bm_so',
        value:
          '177D66891224F2A33BEB79DA089CE14F159E8E0F48726049AF406E6D5A468EB1~YAAQExzFF/wekgmcAQAABbjDGAaptqfpbz+VoqDkbMsPnBYewuDNOS3x53G4KRJUFLXGNn/IWDEFV/NO8K3/etep+YxMZWrCjMoyMQqPXgMdZ8f7uOf5Q21TtTVadLPHOsQtgsTtIYzjAaZjLwOBSac6RJPaexT8IGqGrr2n6aP1ZfTnDryRCJ0b6IYHAoNFDYBcPIH96oycduAcxSdjDWQyqCGtuG5+Sr5PvgvOWRXCG0nTommncnnicV6rhPQKxG0bis556PQwJH6858C3OGhFZcReFaG6CjRqmp3+d4AVfRI6hqnRP1x4dFkWXmQC3d1DXjkbiDDFoc7V7pKf0eWGS2E2RfVFg/JPGlHwdxAORj3rVFGj+H+Y+ewhXRNJnJcaNfANfh99U83ZysROjbd8LIVqpPCGx3Bs7G6wo3oKpUcgHAGIYmDe3aX061BR8OUbQ3Ety2JzYpmBd44=',
      },
      {
        domain: '.costco.com',
        name: 'bm_s',
        value:
          'YAAQExzFF/sekgmcAQAABbjDGASAIan3QSH7hSQQ/kmmvWRakxmKQ0hj9WxuZy4liDCiVe7Zm/Prg6yDs732ON6hcBZEScRHrGK4lzCUi1OzALxhSw1MBMts8UQrOYxUkY6yE+Exqo6LXGIvOE6SFgJX5DT/1vsILXUGeo0HMoykoD+Y+zXokAH7iJ0+h0L/0Dj+gwVHbk968BFlSOy3YkuYCuD3wbOedh5wLo+ivfqiIp/zIiV5aTeO/v2ZhJ77XqRSJlBIIpB3bJyDreoci/H3XO9xNPhNuLPla+9RJ42nt5xg8HeFUp6yMB8RGlpamw56DqMEzjI2OImBO1uFii8DyfsjL+0hRjBk1dN5+mYTYOfIY8ugaRw4nFw22d7+BQRcUWG07bhsdL9gzC4ZGna721JYewxbIH/5Zv9aBYDzRZAZZJgXnBUdClYJJnkOv0zRFy692lrH2m8GfOpP1g+Am0Mvh6vaaQO4OyPAgDJGHgmDAg3rCbQgi2LSc5ephRW98BwIPaGSGTsyEditzkqJ1Wvlgw1E3eK6u3HeBSTsi04qlLNXpkU1MavVSccI',
      },
      {
        domain: '.www.costco.com',
        name: 'RT',
        value:
          '"z=1&dm=www.costco.com&si=38eb67c1-e49f-49a3-bd25-41f837b60f02&ss=ml3lrqsr&sl=1&tt=44l&bcn=%2F%2F684d0d49.akstat.io%2F&ld=44z"',
      },
      {
        domain: '.costco.com',
        name: 'bm_ss',
        value: 'ab8e18ef4e',
      },
      {
        domain: 'www.costco.com',
        name: 'akaas_AS01',
        value: '2147483647~rv=60~id=83e6874e2e487202ec44a0d07268f8e6',
      },
      {
        domain: 'www.costco.com',
        name: '_lr_hb_-costco%2Fproduction-vrwno',
        value: '{%22heartbeat%22:1769942009675}',
      },
      {
        domain: '.costco.com',
        name: 'AKA_A2',
        value: 'A',
      },
    ],
    datadome_value: null,
    domain: 'https://www.costco.com/',
    error: null,
    message: 'Success',
    status: 200,
    title: 'Welcome to Costco Wholesale',
  }['cookies_list'];
*/
};

console.log('--- mr007 ---');
const url = 'https://www.costco.com/';
const site = new URL(url).hostname.split('.')[1] as Site;
const cookies = await mr007({ site });
if (cookies.length === 0) throw new Error('no cookies');
console.log({ cookies: cookies.slice(0, 2) });

cookies.forEach((c) => {
  const domainPart = c.domain.startsWith('.') ? c.domain.slice(1) : c.domain;
  jar.setCookieSync(`${c.name}=${c.value}`, `https://${domainPart}/`);
});
// console.log({ jar: (jar.store as any).idx });
const playwrightCookies = cookies.map((c) => ({
  domain: c.domain,
  name: c.name,
  path: '/',
  sameSite: 'None' as const,
  secure: true,
  value: c.value,
}));

console.log('--- axios ---');
const { data, status } = await axios.request({
  headers: {
    'User-Agent':
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
  },
  jar,
  url,
});
console.log({ status });

console.log('--- playwright ---');
const browser = await chromium.launch({
  args: ['--disable-blink-features=AutomationControlled'],
  devtools: !process.env.CI,
  headless: !!process.env.CI,
});
const context = await browser.newContext();
await context.addCookies(playwrightCookies);
const page = await context.newPage();

try {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  const title = await page.title();
  console.log({ title });
  await new Promise((res) => setTimeout(res, 10000));
} catch (err) {
  console.error({ err });
} finally {
  await browser.close();
}
