from contextvars import ContextVar
from copy import deepcopy


DEFAULT_COMPANY_ID = "superiqfoam"
UNIFIED_PRICE_COMPANIES = frozenset({"iqfoam-manufactoring", "iqfoam-whole-sallers"})
active_company_id = ContextVar("active_company_id", default=None)
active_mongo_session = ContextVar("active_mongo_session", default=None)


def uses_unified_price_list(company_id):
    return company_id in UNIFIED_PRICE_COMPANIES

GLOBAL_COLLECTIONS = {
    "users",
    "companies",
    "user_sessions",
    "user_devices",
    "company_admin_counts",
    "login_attempts",
}

FILTER_METHODS = {
    "find",
    "find_one",
    "count_documents",
    "delete_one",
    "delete_many",
    "find_one_and_delete",
}
UPDATE_METHODS = {"update_one", "update_many", "find_one_and_update"}


def tenant_database(client, base_database, company_id):
    if not company_id or company_id == DEFAULT_COMPANY_ID:
        return base_database
    return client[f"{base_database.name}__{company_id}"]


def _scope_filter(query, company_id):
    query = deepcopy(query) if query else {}
    if query.get("company_id") not in (None, company_id):
        return {"$and": [query, {"company_id": company_id}, {"company_id": {"$ne": query.get("company_id")}}]}
    return {"$and": [query, {"company_id": company_id}]}


def _stamp_document(document, company_id):
    result = deepcopy(document)
    if result.get("company_id") not in (None, company_id):
        raise ValueError("A record cannot be written to another company")
    result["company_id"] = company_id
    return result


def _stamp_update(update, company_id):
    result = deepcopy(update)
    if not any(key.startswith("$") for key in result):
        return _stamp_document(result, company_id)
    values = result.setdefault("$set", {})
    if values.get("company_id") not in (None, company_id):
        raise ValueError("A record cannot be moved to another company")
    insert_values = result.get("$setOnInsert", {})
    if insert_values.get("company_id") not in (None, company_id):
        raise ValueError("A record cannot be moved to another company")
    values["company_id"] = company_id
    return result


class ScopedCollection:
    def __init__(self, collection, company_scoped):
        self._collection = collection
        self._company_scoped = company_scoped

    def __getattr__(self, method_name):
        method = getattr(self._collection, method_name)
        if not self._company_scoped:
            return method
        if method_name not in FILTER_METHODS | UPDATE_METHODS | {"distinct", "aggregate", "insert_one", "insert_many"}:
            return method

        def scoped_call(*args, **kwargs):
            session = active_mongo_session.get()
            if session is not None:
                kwargs.setdefault("session", session)
            company_id = active_company_id.get()
            if not company_id:
                return method(*args, **kwargs)
            args = list(args)
            kwargs = dict(kwargs)

            if method_name in FILTER_METHODS:
                self._scope_arg(args, kwargs, 0, "filter", company_id)
            elif method_name == "distinct":
                self._scope_arg(args, kwargs, 1, "filter", company_id)
            elif method_name in UPDATE_METHODS:
                self._scope_arg(args, kwargs, 0, "filter", company_id)
                self._update_arg(args, kwargs, company_id)
            elif method_name == "aggregate":
                pipeline = deepcopy(args[0] if args else kwargs.get("pipeline", []))
                pipeline.insert(0, {"$match": {"company_id": company_id}})
                if args:
                    args[0] = pipeline
                else:
                    kwargs["pipeline"] = pipeline
            elif method_name == "insert_one":
                self._document_arg(args, kwargs, "document", company_id)
            elif method_name == "insert_many":
                documents = args[0] if args else kwargs.get("documents", [])
                stamped = [_stamp_document(document, company_id) for document in documents]
                if args:
                    args[0] = stamped
                else:
                    kwargs["documents"] = stamped

            return method(*args, **kwargs)

        return scoped_call

    @staticmethod
    def _scope_arg(args, kwargs, index, keyword, company_id):
        if len(args) > index:
            args[index] = _scope_filter(args[index], company_id)
        else:
            kwargs[keyword] = _scope_filter(kwargs.get(keyword), company_id)

    @staticmethod
    def _update_arg(args, kwargs, company_id):
        if len(args) > 1:
            args[1] = _stamp_update(args[1], company_id)
        else:
            kwargs["update"] = _stamp_update(kwargs["update"], company_id)

    @staticmethod
    def _document_arg(args, kwargs, keyword, company_id):
        if args:
            args[0] = _stamp_document(args[0], company_id)
        else:
            kwargs[keyword] = _stamp_document(kwargs[keyword], company_id)


class ScopedDatabase:
    def __init__(self, client, base_database):
        self._client = client
        self._base_database = base_database

    def __getitem__(self, collection_name):
        company_scoped = collection_name not in GLOBAL_COLLECTIONS
        company_id = active_company_id.get()
        database = tenant_database(self._client, self._base_database, company_id)
        return ScopedCollection(database[collection_name], company_scoped)

    def __getattr__(self, collection_name):
        return self[collection_name]