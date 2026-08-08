import type { SubjectProfile } from '@/subjects/profile';

export function causeTaxonomyList(profile: SubjectProfile): string {
  return profile.causeCategories
    .map((category) => {
      const description = category.description ? `：${category.description}` : '';
      return `- ${category.id}（${category.label}）${description}`;
    })
    .join('\n');
}

export function causeIdList(profile: SubjectProfile): string {
  return profile.causeCategories.map((category) => category.id).join(' | ');
}
