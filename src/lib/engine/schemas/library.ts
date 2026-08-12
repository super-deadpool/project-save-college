import type { CategorySchema } from '../types';
import { detailsSlot, durationSlot, impactSlot, locationSlot, scopeSlot } from './shared';

export const librarySchema: CategorySchema = {
  key: 'LIBRARY',
  label: 'Library',
  description: 'Reading room conditions, book availability, portal or printer issues',
  keywords: [
    'library',
    'reading room',
    'book',
    'books',
    'journal',
    'issue desk',
    'return desk',
    'librarian',
    'e-resources',
    'digital library',
    'printer',
    'photocopy',
    'xerox',
  ],
  subcategorySlot: 'problem_type',
  dedupWindowHours: 48,
  slots: [
    {
      key: 'problem_type',
      question: 'What is the library issue?',
      type: 'enum',
      importance: 'REQUIRED',
      infoGain: 0.9,
      options: [
        { value: 'BOOK_UNAVAILABLE', label: 'Book or journal not available', hints: ['book not available', 'no copies', 'out of stock', 'cannot find the book'] },
        { value: 'BOOK_DAMAGED', label: 'Book damaged or pages missing', hints: ['pages missing', 'torn', 'book damaged', 'pages torn'] },
        { value: 'PORTAL_ACCESS', label: 'E-resources / portal access', hints: ['portal', 'e-resources', 'ejournal', 'cannot access', 'login to library'] },
        { value: 'ISSUE_RETURN', label: 'Issue / return or fine problem', hints: ['fine', 'issue desk', 'return not updated', 'due date'] },
        { value: 'SEATING', label: 'Not enough seating', hints: ['no seats', 'seating', 'crowded', 'no place to sit'] },
        { value: 'NOISE', label: 'Too noisy to study', hints: ['noisy', 'noise', 'people talking', 'cannot concentrate'] },
        { value: 'COMFORT', label: 'AC, lighting or ventilation', hints: ['ac not', 'too hot', 'lighting', 'dark', 'stuffy'] },
        { value: 'PRINTER', label: 'Printer / photocopier not working', hints: ['printer', 'photocopy', 'xerox', 'scanner'] },
        { value: 'CLEANLINESS', label: 'Cleanliness', hints: ['dirty', 'dusty', 'not cleaned'] },
      ],
      extractHints: ['library', 'reading room'],
      unsureDefault: 'BOOK_UNAVAILABLE',
    },
    locationSlot({
      question: 'Which part of the library?',
      importance: 'RECOMMENDED',
      placeholder: 'e.g. Library Reading Room',
    }),
    impactSlot({ question: 'Is this blocking exam preparation or a submission?' }),
    scopeSlot({
      question: 'Is it just you or everyone there?',
      options: [
        { value: 'ONLY_ME', label: 'Just me', hints: ['just me', 'only me'] },
        { value: 'FEW', label: 'A few students', hints: ['few of us', 'some of us'] },
        { value: 'MANY', label: 'Everyone in the hall', hints: ['everyone', 'all of us', 'whole reading room'] },
        { value: 'BUILDING', label: 'The whole library', hints: ['whole library', 'entire library'] },
      ],
    }),
    durationSlot({ question: 'How long has this been the case?' }),
    detailsSlot({ question: 'Anything else (book title, accession number)?' }),
  ],
};
