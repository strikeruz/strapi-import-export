import qs from 'qs';

export function buildFilterQuery(search = '') {
    const parsed = qs.parse(search);
    const { filters, sort: sortRaw } = parsed;

    // Handle the sort parameter type-safely
    let sort = {};
    if (typeof sortRaw === 'string') {
        const [attr, value] = sortRaw.split(':');
        if (attr && value) {
            sort[attr] = value.toLowerCase();
        }
    }

    return {
        filters,
        sort,
    };
} 