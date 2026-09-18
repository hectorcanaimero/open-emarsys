/**
 * Rejects the most common breached passwords (padded/extended to the 12-char minimum) plus
 * trivial patterns (all one character, fully sequential digits). Not exhaustive — a denylist
 * only needs to catch what people actually try first.
 */
const COMMON = new Set([
  '123456789012',
  '1234567890123',
  '12345678901234',
  'password1234',
  'password12345',
  'passw0rd1234',
  'qwertyuiop123',
  'qwertyuiop1234',
  'qwertyqwerty',
  'letmein123456',
  'letmein12345',
  'iloveyou1234',
  'iloveyou12345',
  'trustno12345',
  'welcome123456',
  'welcome12345',
  'admin12345678',
  'administrator',
  'changeme12345',
  'football12345',
  'baseball12345',
  'superman12345',
  'princess12345',
  'sunshine12345',
  'monkey1234567',
  'dragon1234567',
  'shadow1234567',
  'master1234567',
  'freedom123456',
  'whatever12345',
  'starwars12345',
  'summer12345678',
  'winter12345678',
  'autumn12345678',
  'hunter12345678',
  '1qaz2wsx3edc',
  'zaq12wsx3edc4',
  'q1w2e3r4t5y6',
  '1q2w3e4r5t6y',
  'abcdefghijkl',
  'abc123abc123',
  'correcthorse',
  'correcthorsebattery',
  'p@ssw0rd12345',
]);

function isSequential(password: string): boolean {
  if (!/^\d+$/.test(password)) return false;
  const codes = [...password].map((c) => c.charCodeAt(0));
  const ascending = codes.every((c, i) => i === 0 || c === codes[i - 1] + 1);
  const descending = codes.every((c, i) => i === 0 || c === codes[i - 1] - 1);
  return ascending || descending;
}

function isSingleCharacter(password: string): boolean {
  return password.length > 0 && [...password].every((c) => c === password[0]);
}

export function isCommonPassword(password: string): boolean {
  const lower = password.toLowerCase();
  return COMMON.has(lower) || isSequential(password) || isSingleCharacter(lower);
}
