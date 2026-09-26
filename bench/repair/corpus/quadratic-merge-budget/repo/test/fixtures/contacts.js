// Contact rows for the import budget, generated from a seed so every run merges the same rows. About duplicateRate of
// the rows repeat an earlier person: their email in another case, with or without dots, with a +tag or at the other
// Gmail domain, and some of their fields empty. generateContacts returns the rows and the true number of people.
const FIRST = ['ada', 'alan', 'barbara', 'claude', 'donald', 'edsger', 'frances', 'grace', 'john', 'katherine', 'linus', 'margaret', 'niklaus', 'radia', 'shafi', 'tim'];
const LAST = ['allen', 'backus', 'dijkstra', 'goldwasser', 'hamilton', 'hopper', 'johnson', 'knuth', 'liskov', 'lovelace', 'perlman', 'shannon', 'thompson', 'torvalds', 'turing', 'wirth'];
const DOMAINS = ['gmail.com', 'googlemail.com', 'example.com', 'example.org', 'mail.example.net'];
const COMPANIES = ['Acme', 'Globex', 'Initech', 'Umbrella', 'Hooli', 'Vandelay'];
const TAGS = ['news', 'shop', 'work', 'crm'];
const GMAIL = new Set(['gmail.com', 'googlemail.com']);
const capitalize = word => word[0].toUpperCase() + word.slice(1);

export function generateContacts({ seed, count, duplicateRate }) {
  let state = seed >>> 0;
  // A linear congruential generator with Numerical Recipes' constants: a number in [0, 1).
  const random = () => (state = (Math.imul(state, 1664525) + 1013904223) >>> 0) / 4294967296;
  const pick = list => list[Math.floor(random() * list.length)];
  const people = [], rows = [];
  for (let index = 0; index < count; index++) {
    if (people.length && random() < duplicateRate) {
      rows.push(repeat(pick(people), random, pick));
      continue;
    }
    // Every person's address is unique, however it is written: the local part ends with the person's number.
    const first = pick(FIRST), last = pick(LAST);
    const person = {
      name: `${capitalize(first)} ${capitalize(last)}`, local: `${first}.${last}${people.length}`, domain: pick(DOMAINS),
      phone: `+1 555 ${String(people.length % 10000).padStart(4, '0')}`, company: pick(COMPANIES),
    };
    people.push(person);
    rows.push({ name: person.name, email: `${person.local}@${person.domain}`, phone: random() < 0.5 ? person.phone : '', company: random() < 0.5 ? person.company : '' });
  }
  return { rows, people: people.length };
}

// A later row of a person: the same email key written another way, and some fields empty.
function repeat(person, random, pick) {
  let local = person.local, domain = person.domain;
  if (GMAIL.has(domain)) {
    const dots = random();
    if (dots < 0.4) local = local.replaceAll('.', '');
    else if (dots < 0.7) local = `${local[0]}.${local.slice(1)}`;
    if (random() < 0.4) local += `+${pick(TAGS)}`;
    if (random() < 0.5) domain = domain === 'gmail.com' ? 'googlemail.com' : 'gmail.com';
  }
  let email = `${local}@${domain}`;
  const letters = random();
  if (letters < 0.3) email = email.toUpperCase();
  else if (letters < 0.6) email = capitalize(email);
  if (random() < 0.2) email = ` ${email} `;
  return { name: random() < 0.3 ? '' : person.name, email, phone: random() < 0.6 ? person.phone : '', company: random() < 0.6 ? person.company : '' };
}
