/* VFS-local plugin entry: keep package inventory on a file path, then use the
 * Worker static module so the provider shares the mounted DSH runtime identity. */
module.exports = require('@deepseek-ai/dsh-browser-native-session-persistence')
