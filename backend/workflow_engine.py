import math
import re


TRIGGER_DEFINITIONS = {
    "invoice.created": {
        "label": "Invoice created",
        "fields": {
            "status": "text",
            "total": "number",
            "date": "text",
            "customer_name": "text",
        },
    },
    "invoice.updated": {
        "label": "Invoice updated",
        "fields": {
            "status": "text",
            "total": "number",
            "date": "text",
            "customer_name": "text",
            "number": "text",
        },
    },
    "invoice.issued": {
        "label": "Invoice issued",
        "fields": {
            "status": "text",
            "total": "number",
            "date": "text",
            "customer_name": "text",
            "number": "text",
        },
    },
    "invoice.voided": {
        "label": "Invoice voided",
        "fields": {
            "date": "text",
            "customer_name": "text",
            "number": "text",
        },
    },
    "payment.recorded": {
        "label": "Payment recorded",
        "fields": {
            "amount": "number",
            "method": "text",
            "date": "text",
            "invoice_number": "text",
        },
    },
    "payment.reversed": {
        "label": "Payment reversed",
        "fields": {
            "amount": "number",
            "method": "text",
            "date": "text",
            "invoice_number": "text",
        },
    },
    "customer.created": {
        "label": "Customer created",
        "fields": {
            "name": "text",
            "city": "text",
            "default_zone": "number",
            "active": "boolean",
        },
    },
    "customer.updated": {
        "label": "Customer updated",
        "fields": {
            "name": "text",
            "city": "text",
            "default_zone": "number",
            "active": "boolean",
        },
    },
    "order.created": {
        "label": "Order created",
        "fields": {
            "status": "text",
            "priority": "text",
            "expected_ship_date": "text",
            "destination": "text",
        },
    },
    "order.updated": {
        "label": "Order updated",
        "fields": {
            "status": "text",
            "priority": "text",
            "expected_ship_date": "text",
            "destination": "text",
        },
    },
    "stock.movement_recorded": {
        "label": "Stock movement recorded",
        "fields": {
            "type": "text",
            "quantity": "number",
            "product": "text",
            "size": "text",
        },
    },
    "buying.created": {
        "label": "Purchase recorded",
        "fields": {
            "product": "text",
            "source": "text",
            "quantity": "number",
            "amount": "number",
            "date": "text",
        },
    },
    "buying.updated": {
        "label": "Purchase updated",
        "fields": {
            "product": "text",
            "source": "text",
            "quantity": "number",
            "amount": "number",
            "date": "text",
        },
    },
    "buying.voided": {
        "label": "Purchase voided",
        "fields": {
            "product": "text",
            "source": "text",
            "amount": "number",
            "date": "text",
        },
    },
    "supplier.created": {
        "label": "Supplier created",
        "fields": {
            "name": "text",
            "city": "text",
            "active": "boolean",
        },
    },
    "supplier.updated": {
        "label": "Supplier updated",
        "fields": {
            "name": "text",
            "city": "text",
            "active": "boolean",
        },
    },
    "supplier.deactivated": {
        "label": "Supplier deactivated",
        "fields": {
            "name": "text",
            "city": "text",
            "active": "boolean",
        },
    },
    "purchase_order.created": {
        "label": "Purchase request created",
        "fields": {
            "reference": "text",
            "status": "text",
            "supplier_name": "text",
            "expected_date": "text",
            "total": "number",
        },
    },
    "purchase_order.updated": {
        "label": "Purchase request updated",
        "fields": {
            "reference": "text",
            "status": "text",
            "supplier_name": "text",
            "expected_date": "text",
            "total": "number",
        },
    },
    "purchase_order.ordered": {
        "label": "Purchase request ordered",
        "fields": {
            "reference": "text",
            "status": "text",
            "supplier_name": "text",
            "expected_date": "text",
            "total": "number",
        },
    },
    "purchase_order.received": {
        "label": "Purchase request received",
        "fields": {
            "reference": "text",
            "status": "text",
            "supplier_name": "text",
            "expected_date": "text",
            "total": "number",
        },
    },
    "grv.created": {
        "label": "Goods receipt created",
        "fields": {
            "grv_number": "text",
            "status": "text",
            "supplier_name": "text",
            "received_date": "text",
            "item_count": "number",
        },
    },
    "grv.updated": {
        "label": "Goods receipt draft updated",
        "fields": {
            "grv_number": "text",
            "status": "text",
            "supplier_name": "text",
            "received_date": "text",
            "item_count": "number",
        },
    },
    "grv.pending_inspection": {
        "label": "Goods receipt sent for inspection",
        "fields": {
            "grv_number": "text",
            "status": "text",
            "supplier_name": "text",
            "received_date": "text",
            "item_count": "number",
        },
    },
    "grv.confirmed": {
        "label": "Goods receipt confirmed",
        "fields": {
            "grv_number": "text",
            "status": "text",
            "supplier_name": "text",
            "received_date": "text",
            "item_count": "number",
        },
    },
    "grv.cancelled": {
        "label": "Goods receipt cancelled or reversed",
        "fields": {
            "grv_number": "text",
            "status": "text",
            "supplier_name": "text",
            "received_date": "text",
            "item_count": "number",
        },
    },
    "production.created": {
        "label": "Production record created",
        "fields": {
            "status": "text",
            "quantity": "number",
            "block_ref": "text",
            "production_date": "text",
        },
    },
    "production.completed": {
        "label": "Production record completed",
        "fields": {
            "status": "text",
            "quantity": "number",
            "block_ref": "text",
            "production_date": "text",
        },
    },
    "production.daily_saved": {
        "label": "Daily production saved",
        "fields": {
            "date": "text",
            "white_blocks": "number",
            "blue_blocks": "number",
            "total_blocks": "number",
        },
    },
    "attendance.recorded": {
        "label": "Attendance recorded",
        "fields": {
            "status": "text",
            "date": "text",
            "department": "text",
            "overtime_hours": "number",
        },
    },
    "piece_production.saved": {
        "label": "Piece production recorded",
        "fields": {
            "date": "text",
            "pieces": "number",
        },
    },
    "employee.created": {
        "label": "Employee added",
        "fields": {
            "department": "text",
            "active": "boolean",
        },
    },
    "employee.updated": {
        "label": "Employee updated",
        "fields": {
            "department": "text",
            "active": "boolean",
        },
    },
    "expense.recorded": {
        "label": "Expense recorded",
        "fields": {
            "category": "text",
            "amount": "number",
            "date": "text",
            "description": "text",
        },
    },
    "expense.voided": {
        "label": "Expense voided",
        "fields": {
            "category": "text",
            "amount": "number",
            "date": "text",
            "description": "text",
        },
    },
    "vehicle_record.created": {
        "label": "Vehicle cost or maintenance recorded",
        "fields": {
            "type": "text",
            "status": "text",
            "amount": "number",
            "date": "text",
            "vehicle_name": "text",
        },
    },
    "vehicle_record.updated": {
        "label": "Vehicle cost or maintenance updated",
        "fields": {
            "type": "text",
            "status": "text",
            "amount": "number",
            "date": "text",
            "vehicle_name": "text",
        },
    },
    "vehicle_record.cancelled": {
        "label": "Vehicle cost cancelled",
        "fields": {
            "type": "text",
            "amount": "number",
            "date": "text",
            "vehicle_name": "text",
        },
    },
    "vehicle.created": {
        "label": "Vehicle added",
        "fields": {
            "name": "text",
            "vtype": "text",
            "available": "boolean",
        },
    },
    "vehicle.updated": {
        "label": "Vehicle updated",
        "fields": {
            "name": "text",
            "vtype": "text",
            "available": "boolean",
        },
    },
    "vehicle.archived": {
        "label": "Vehicle archived",
        "fields": {
            "name": "text",
            "vtype": "text",
            "available": "boolean",
        },
    },
    "driver.created": {
        "label": "Driver added",
        "fields": {
            "name": "text",
            "size_pref": "text",
            "active": "boolean",
        },
    },
    "driver.updated": {
        "label": "Driver updated",
        "fields": {
            "name": "text",
            "size_pref": "text",
            "active": "boolean",
        },
    },
    "spare_part.created": {
        "label": "Spare part added",
        "fields": {
            "name": "text",
            "status": "text",
            "quantity": "number",
        },
    },
    "spare_part.updated": {
        "label": "Spare part updated",
        "fields": {
            "name": "text",
            "status": "text",
            "quantity": "number",
        },
    },
    "spare_part.archived": {
        "label": "Spare part archived",
        "fields": {
            "name": "text",
            "status": "text",
            "quantity": "number",
        },
    },
    "spare_part.restored": {
        "label": "Spare part restored",
        "fields": {
            "name": "text",
            "status": "text",
            "quantity": "number",
        },
    },
    "delivery.status_changed": {
        "label": "Delivery status changed",
        "fields": {
            "status": "text",
            "reference": "text",
            "size": "text",
            "customer_name": "text",
            "destination": "text",
        },
    },
    "delivery.created": {
        "label": "Delivery created",
        "fields": {
            "status": "text",
            "reference": "text",
            "size": "text",
            "customer_name": "text",
            "destination": "text",
        },
    },
    "delivery.dispatched": {
        "label": "Delivery dispatched",
        "fields": {
            "status": "text",
            "reference": "text",
            "priority": "text",
            "customer_name": "text",
            "destination": "text",
        },
    },
}

ACTION_DEFINITIONS = {
    "create_notification": "Create internal notification",
    "create_follow_up_task": "Create follow-up task",
    "prepare_draft_document": "Prepare draft document",
    "prepare_draft_purchase_request": "Prepare draft purchase request",
    "add_internal_flag": "Add internal warning or flag",
    "update_internal_report": "Add internal report update",
    "request_global_owner_approval": "Request Global Owner approval",
}

OPERATORS_BY_TYPE = {
    "text": ("equals", "not_equals", "contains", "is_empty", "is_not_empty"),
    "number": ("equals", "not_equals", "greater_than", "less_than", "is_empty", "is_not_empty"),
    "boolean": ("equals", "not_equals", "is_empty", "is_not_empty"),
}


class WorkflowValidationError(ValueError):
    pass


def _validate_value(value, field_type, field):
    if field_type == "text":
        if not isinstance(value, str) or len(value) > 500:
            raise WorkflowValidationError(f"{field} must be text (maximum 500 characters)")
    elif field_type == "number":
        if isinstance(value, bool) or not isinstance(value, (int, float)) or not math.isfinite(value):
            raise WorkflowValidationError(f"{field} must be a finite number")
    elif field_type == "boolean" and not isinstance(value, bool):
        raise WorkflowValidationError(f"{field} must be true or false")


def validate_workflow_definition(data):
    if not isinstance(data, dict):
        raise WorkflowValidationError("Workflow definition must be an object")
    name = data.get("name")
    if not isinstance(name, str) or not name.strip() or len(name.strip()) > 120:
        raise WorkflowValidationError("Workflow name is required and must be at most 120 characters")
    trigger = data.get("trigger")
    definition = TRIGGER_DEFINITIONS.get(trigger)
    if not definition:
        raise WorkflowValidationError("Unsupported workflow trigger")
    logic = data.get("logic", "all")
    if logic not in ("all", "any"):
        raise WorkflowValidationError("Condition logic must be all or any")

    conditions = data.get("conditions", [])
    if not isinstance(conditions, list) or len(conditions) > 20:
        raise WorkflowValidationError("A workflow can have at most 20 conditions")
    normalized_conditions = []
    for condition in conditions:
        if not isinstance(condition, dict) or set(condition) - {"field", "operator", "value"}:
            raise WorkflowValidationError("Each condition must contain only field, operator and value")
        field = condition.get("field")
        field_type = definition["fields"].get(field)
        operator = condition.get("operator")
        if not field_type or operator not in OPERATORS_BY_TYPE[field_type]:
            raise WorkflowValidationError("Condition field or operator is not supported for this trigger")
        value = condition.get("value")
        if operator not in ("is_empty", "is_not_empty"):
            _validate_value(value, field_type, field)
        normalized_conditions.append({
            "field": field,
            "operator": operator,
            "value": value if operator not in ("is_empty", "is_not_empty") else None,
        })

    actions = data.get("actions", [])
    if not isinstance(actions, list) or not 1 <= len(actions) <= 10:
        raise WorkflowValidationError("Add between 1 and 10 approved actions")
    normalized_actions = []
    for action in actions:
        if not isinstance(action, dict) or set(action) - {"type", "title", "message"}:
            raise WorkflowValidationError("Each action may contain only type, title and message")
        action_type = action.get("type")
        if action_type not in ACTION_DEFINITIONS:
            raise WorkflowValidationError("Unsupported workflow action")
        title = action.get("title", "")
        message = action.get("message", "")
        if not isinstance(title, str) or len(title.strip()) > 120:
            raise WorkflowValidationError("Action titles must be at most 120 characters")
        if not isinstance(message, str) or not message.strip() or len(message.strip()) > 1000:
            raise WorkflowValidationError("Each action needs a message of at most 1000 characters")
        if re.search(r"(?:https?://|javascript:)", f"{title} {message}", re.IGNORECASE):
            raise WorkflowValidationError("Action content cannot configure external URLs or scripts")
        allowed_fields = set(definition["fields"])
        for content in (title, message):
            placeholders = re.findall(r"{{\s*([^{}]+?)\s*}}", content)
            if "{{" in content and len(placeholders) != content.count("{{"):
                raise WorkflowValidationError("Use only simple {{field_name}} action placeholders")
            if set(placeholders) - allowed_fields:
                raise WorkflowValidationError("Action placeholders must use fields available for this trigger")
        normalized_actions.append({
            "type": action_type,
            "title": title.strip(),
            "message": message.strip(),
        })

    return {
        "name": name.strip(),
        "trigger": trigger,
        "logic": logic,
        "conditions": normalized_conditions,
        "actions": normalized_actions,
        "enabled": data.get("enabled", False) is True,
    }


def evaluate_conditions(trigger, conditions, logic, payload):
    definition = TRIGGER_DEFINITIONS.get(trigger)
    if not definition:
        raise WorkflowValidationError("Unsupported workflow trigger")
    results = []
    for condition in conditions:
        field = condition["field"]
        operator = condition["operator"]
        actual = payload.get(field)
        expected = condition.get("value")
        if operator == "equals":
            matched = actual == expected
        elif operator == "not_equals":
            matched = actual != expected
        elif operator == "greater_than":
            matched = isinstance(actual, (int, float)) and not isinstance(actual, bool) and actual > expected
        elif operator == "less_than":
            matched = isinstance(actual, (int, float)) and not isinstance(actual, bool) and actual < expected
        elif operator == "contains":
            matched = isinstance(actual, str) and expected in actual
        elif operator == "is_empty":
            matched = actual is None or actual == ""
        elif operator == "is_not_empty":
            matched = actual is not None and actual != ""
        else:
            raise WorkflowValidationError("Unsupported condition operator")
        results.append({"field": field, "operator": operator, "matched": bool(matched)})
    if not results:
        return True, results
    return (all if logic == "all" else any)(item["matched"] for item in results), results


def event_payload(trigger, record):
    fields = TRIGGER_DEFINITIONS[trigger]["fields"]
    payload = {
        field: record[field]
        for field in fields
        if field in record and record[field] is not None
    }
    if "total" in fields and "total" not in payload and "amount" in record:
        payload["total"] = record["amount"]
    return payload


def render_action_template(template, payload):
    return re.sub(
        r"{{\s*([a-z][a-z0-9_]*)\s*}}",
        lambda match: (
            "(not provided)"
            if payload.get(match.group(1)) is None
            else str(payload[match.group(1)])
        ),
        template,
    )


def validate_event_payload(trigger, payload):
    definition = TRIGGER_DEFINITIONS.get(trigger)
    if not definition or not isinstance(payload, dict):
        raise WorkflowValidationError("Dry-run data must be an object for a supported trigger")
    if set(payload) - set(definition["fields"]):
        raise WorkflowValidationError("Dry-run data contains fields not supported by this trigger")
    for field, value in payload.items():
        _validate_value(value, definition["fields"][field], field)
    return payload
