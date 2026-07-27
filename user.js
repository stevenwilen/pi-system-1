// Who every request is.
//
// Until there is real auth there is one person, and every query in this system
// filters on this id rather than trusting the database to do it: the service
// key bypasses row level security, so scoping is the code's job.
//
// Overridable only so a test can point a whole server at a throwaway user and
// be structurally unable to touch real rows. It defaults to the real id, so
// production behaviour is unchanged by its existence.

require('dotenv').config();

const CURRENT_USER = process.env.PI_USER_ID || '00000000-0000-0000-0000-000000000001';

module.exports = { CURRENT_USER };
