// GET /api/brief/dates, GET /api/brief — port of routers/brief.py (reads only;
// POST /api/brief/run needs the brief generator, Phase 4).

export default [
  {
    file: "brief-dates",
    method: "GET",
    path: "/api/brief/dates",
    auth: "user",
    sql: `
select coalesce(json_agg(d.brief_date order by d.brief_date desc), '[]'::json) as data
from (select distinct brief_date from daily_briefs order by brief_date desc limit 30) d`,
    shape: "return { body: data };",
  },
  {
    file: "brief",
    method: "GET",
    path: "/api/brief",
    auth: "user",
    validate: `
const d = (req.query || {}).date;
if (d !== undefined && d !== '' && !isDate(d)) return invalid(['query', 'date'], 'Input should be a valid date');
return { date: d || null };`,
    params: "[$('Validate').first().json.value.date]",
    sql: `
with pick as (select coalesce($1::date, (select max(brief_date) from daily_briefs)) as d)
select json_build_object(
  'date', (select d from pick),
  'clients', coalesce((
    select json_agg(x order by case x.score when 'red' then 0 when 'yellow' then 1 else 2 end, x.name)
    from (
      select b.*, c.slug, c.name, c.booking_system
      from daily_briefs b join clients c on c.id = b.client_id, pick
      where b.brief_date = pick.d
    ) x
  ), '[]'::json)
) as data`,
    shape: "return { body: data };",
  },
];
