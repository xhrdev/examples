// node dev-resources/repl.cjs
const fs = require('node:fs');
const cheerio = require('cheerio');
const html = fs.readFileSync('./test/fixtures/example.html', 'utf8');
const $ = cheerio.load(html);

let x = $('#cm-cr-dp-review-list li')
  .toArray()
  .map((li) => {
    const el = $(li);

    let country = '';
    let date = '';
    const match = el.find('span[data-hook="review-date"]').text().match(/^Reviewed in the (.+?) on (.+)$/);
    if (match) {
      country = match[1];
      date = match[2];
    }

    return {
      id: el.attr('id'),
      author: el.find('div.a-profile-content span.a-profile-name').first().text(),
      title: el.find('a[data-hook="review-title"] span:nth-child(3)').text(),
      rating: el.find('i[data-hook="review-star-rating"]').text().slice(0, 3),
      country,
      date,
      text: el.find('span[data-hook="review-body"] div[data-hook="review-collapsed"] span').text(),
    };
  });

console.log(x)
