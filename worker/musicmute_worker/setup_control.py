"""Small protected local command mailbox; never takes the worker lifetime lock."""

from uuid import uuid4

from .runtime_types import uuid4_string


class CommandMailbox:
    def __init__(self, records):
        self.records = records

    def submit(self, action):
        if action not in ("pause", "repair", "uninstall"):
            raise ValueError("Invalid maintenance action")
        if len(list(self.records.root.glob("command-*.json"))) >= 32:
            raise RuntimeError(
                "Local command mailbox is full; inspect retained receipts"
            )
        identity = str(uuid4())
        self.records.write(
            "command-" + identity + ".json",
            {
                "schemaVersion": 3,
                "operationId": identity,
                "action": action,
                "result": None,
            },
        )
        return identity

    def receipt(self, identity):
        uuid4_string(identity)
        value = self.records.read("command-" + identity + ".json")
        if (
            not value
            or set(value) != {"schemaVersion", "operationId", "action", "result"}
            or value["operationId"] != identity
            or value["action"] not in ("pause", "repair", "uninstall")
        ):
            raise ValueError("Invalid maintenance request")
        return value

    def pending(self):
        result = []
        files = sorted(self.records.root.glob("command-*.json"))
        if len(files) > 32:
            raise ValueError("Local command mailbox exceeds bound")
        for path in files:
            value = self.receipt(
                path.name.removeprefix("command-").removesuffix(".json")
            )
            if value["result"] is None:
                result.append(value)
        return result

    def finish(self, identity, result):
        if result not in ("paused", "repaired", "service_removed_state_retained"):
            raise ValueError("Invalid maintenance receipt")
        value = self.receipt(identity)
        if value["result"] is not None and value["result"] != result:
            raise ValueError("Conflicting maintenance receipt")
        value["result"] = result
        self.records.write("command-" + identity + ".json", value)
