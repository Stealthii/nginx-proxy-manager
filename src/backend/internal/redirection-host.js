'use strict';

const _                    = require('lodash');
const error                = require('../lib/error');
const redirectionHostModel = require('../models/redirection_host');
const internalHost         = require('./host');
const internalNginx        = require('./nginx');
const internalAuditLog     = require('./audit-log');
const internalCertificate  = require('./certificate');

function omissions () {
    return ['is_deleted'];
}

const internalRedirectionHost = {

    /**
     * @param   {Access}  access
     * @param   {Object}  data
     * @returns {Promise}
     */
    create: (access, data) => {
        let create_certificate = data.certificate_id === 'new';

        if (create_certificate) {
            delete data.certificate_id;
        }

        return access.can('redirection_hosts:create', data)
            .then(access_data => {
                // Get a list of the domain names and check each of them against existing records
                let domain_name_check_promises = [];

                data.domain_names.map(function (domain_name) {
                    domain_name_check_promises.push(internalHost.isHostnameTaken(domain_name));
                });

                return Promise.all(domain_name_check_promises)
                    .then(check_results => {
                        check_results.map(function (result) {
                            if (result.is_taken) {
                                throw new error.ValidationError(result.hostname + ' is already in use');
                            }
                        });
                    });
            })
            .then(() => {
                // At this point the domains should have been checked
                data.owner_user_id = access.token.get('attrs').id;

                return redirectionHostModel
                    .query()
                    .omit(omissions())
                    .insertAndFetch(data);
            })
            .then(row => {
                if (create_certificate) {
                    return internalCertificate.createQuickCertificate(access, data)
                        .then(cert => {
                            // update host with cert id
                            return internalRedirectionHost.update(access, {
                                id:             row.id,
                                certificate_id: cert.id
                            });
                        })
                        .then(() => {
                            return row;
                        });
                } else {
                    return row;
                }
            })
            .then(row => {
                // re-fetch with cert
                return internalRedirectionHost.get(access, {
                    id:     row.id,
                    expand: ['certificate', 'owner']
                });
            })
            .then(row => {
                // Configure nginx
                return internalNginx.configure(redirectionHostModel, 'redirection_host', row)
                    .then(() => {
                        return row;
                    });
            })
            .then(row => {
                data.meta = _.assign({}, data.meta || {}, row.meta);

                // Add to audit log
                return internalAuditLog.add(access, {
                    action:      'created',
                    object_type: 'redirection-host',
                    object_id:   row.id,
                    meta:        data
                })
                    .then(() => {
                        return row;
                    });
            });
    },

    /**
     * @param  {Access}  access
     * @param  {Object}  data
     * @param  {Integer} data.id
     * @return {Promise}
     */
    update: (access, data) => {
        let create_certificate = data.certificate_id === 'new';

        if (create_certificate) {
            delete data.certificate_id;
        }

        return access.can('redirection_hosts:update', data.id)
            .then(access_data => {
                // Get a list of the domain names and check each of them against existing records
                let domain_name_check_promises = [];

                if (typeof data.domain_names !== 'undefined') {
                    data.domain_names.map(function (domain_name) {
                        domain_name_check_promises.push(internalHost.isHostnameTaken(domain_name, 'redirection', data.id));
                    });

                    return Promise.all(domain_name_check_promises)
                        .then(check_results => {
                            check_results.map(function (result) {
                                if (result.is_taken) {
                                    throw new error.ValidationError(result.hostname + ' is already in use');
                                }
                            });
                        });
                }
            })
            .then(() => {
                return internalRedirectionHost.get(access, {id: data.id});
            })
            .then(row => {
                if (row.id !== data.id) {
                    // Sanity check that something crazy hasn't happened
                    throw new error.InternalValidationError('Redirection Host could not be updated, IDs do not match: ' + row.id + ' !== ' + data.id);
                }

                if (create_certificate) {
                    return internalCertificate.createQuickCertificate(access, {
                        domain_names: data.domain_names || row.domain_names,
                        meta:         _.assign({}, row.meta, data.meta)
                    })
                        .then(cert => {
                            // update host with cert id
                            data.certificate_id = cert.id;
                        })
                        .then(() => {
                            return row;
                        });
                } else {
                    return row;
                }
            })
            .then(row => {
                // Add domain_names to the data in case it isn't there, so that the audit log renders correctly. The order is important here.
                data = _.assign({}, {
                    domain_names: row.domain_names
                },data);

                return redirectionHostModel
                    .query()
                    .where({id: data.id})
                    .patch(data)
                    .then(saved_row => {
                        // Add to audit log
                        return internalAuditLog.add(access, {
                            action:      'updated',
                            object_type: 'redirection-host',
                            object_id:   row.id,
                            meta:        data
                        })
                            .then(() => {
                                return _.omit(saved_row, omissions());
                            });
                    });
            })
            .then(() => {
                return internalRedirectionHost.get(access, {
                    id:     data.id,
                    expand: ['owner', 'certificate']
                })
                    .then(row => {
                        // Configure nginx
                        return internalNginx.configure(redirectionHostModel, 'redirection_host', row)
                            .then(() => {
                                return _.omit(row, omissions());
                            });
                    });
            });
    },

    /**
     * @param  {Access}   access
     * @param  {Object}   data
     * @param  {Integer}  data.id
     * @param  {Array}    [data.expand]
     * @param  {Array}    [data.omit]
     * @return {Promise}
     */
    get: (access, data) => {
        if (typeof data === 'undefined') {
            data = {};
        }

        return access.can('redirection_hosts:get', data.id)
            .then(access_data => {
                let query = redirectionHostModel
                    .query()
                    .where('is_deleted', 0)
                    .andWhere('id', data.id)
                    .allowEager('[owner,certificate]')
                    .first();

                if (access_data.permission_visibility !== 'all') {
                    query.andWhere('owner_user_id', access.token.get('attrs').id);
                }

                // Custom omissions
                if (typeof data.omit !== 'undefined' && data.omit !== null) {
                    query.omit(data.omit);
                }

                if (typeof data.expand !== 'undefined' && data.expand !== null) {
                    query.eager('[' + data.expand.join(', ') + ']');
                }

                return query;
            })
            .then(row => {
                if (row) {
                    return _.omit(row, omissions());
                } else {
                    throw new error.ItemNotFoundError(data.id);
                }
            });
    },

    /**
     * @param {Access}  access
     * @param {Object}  data
     * @param {Integer} data.id
     * @param {String}  [data.reason]
     * @returns {Promise}
     */
    delete: (access, data) => {
        return access.can('redirection_hosts:delete', data.id)
            .then(() => {
                return internalRedirectionHost.get(access, {id: data.id});
            })
            .then(row => {
                if (!row) {
                    throw new error.ItemNotFoundError(data.id);
                }

                return redirectionHostModel
                    .query()
                    .where('id', row.id)
                    .patch({
                        is_deleted: 1
                    })
                    .then(() => {
                        // Delete Nginx Config
                        return internalNginx.deleteConfig('redirection_host', row)
                            .then(() => {
                                return internalNginx.reload();
                            });
                    })
                    .then(() => {
                        // Add to audit log
                        return internalAuditLog.add(access, {
                            action:      'deleted',
                            object_type: 'redirection-host',
                            object_id:   row.id,
                            meta:        _.omit(row, omissions())
                        });
                    });
            })
            .then(() => {
                return true;
            });
    },

    /**
     * All Hosts
     *
     * @param   {Access}  access
     * @param   {Array}   [expand]
     * @param   {String}  [search_query]
     * @returns {Promise}
     */
    getAll: (access, expand, search_query) => {
        return access.can('redirection_hosts:list')
            .then(access_data => {
                let query = redirectionHostModel
                    .query()
                    .where('is_deleted', 0)
                    .groupBy('id')
                    .omit(['is_deleted'])
                    .allowEager('[owner,certificate]')
                    .orderBy('domain_names', 'ASC');

                if (access_data.permission_visibility !== 'all') {
                    query.andWhere('owner_user_id', access.token.get('attrs').id);
                }

                // Query is used for searching
                if (typeof search_query === 'string') {
                    query.where(function () {
                        this.where('domain_names', 'like', '%' + search_query + '%');
                    });
                }

                if (typeof expand !== 'undefined' && expand !== null) {
                    query.eager('[' + expand.join(', ') + ']');
                }

                return query;
            });
    },

    /**
     * Report use
     *
     * @param   {Integer} user_id
     * @param   {String}  visibility
     * @returns {Promise}
     */
    getCount: (user_id, visibility) => {
        let query = redirectionHostModel
            .query()
            .count('id as count')
            .where('is_deleted', 0);

        if (visibility !== 'all') {
            query.andWhere('owner_user_id', user_id);
        }

        return query.first()
            .then(row => {
                return parseInt(row.count, 10);
            });
    }
};

module.exports = internalRedirectionHost;
