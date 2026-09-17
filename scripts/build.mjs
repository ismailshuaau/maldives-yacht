import { cpSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

const output = 'public';
const pages = ['index.html', 'search.html', 'yacht.html', 'booking.html', 'vendor.html', 'admin.html', 'admin-content.html', 'account.html', 'login.html', 'payment-return.html', 'privacy.html', 'terms.html', 'README.md'];

rmSync(output, { recursive: true, force: true });
mkdirSync(join(output, 'assets'), { recursive: true });
for (const page of pages) cpSync(page, join(output, page));
cpSync('assets', join(output, 'assets'), { recursive: true });
