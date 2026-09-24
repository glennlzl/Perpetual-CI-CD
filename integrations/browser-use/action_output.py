"""Keep one model decision aligned with one executed browser action."""

from copy import deepcopy
from functools import lru_cache

@lru_cache(maxsize=128)
def single_action_output(output_format):
    if output_format is None or "action" not in output_format.model_fields:
        return output_format
    from annotated_types import MaxLen, MinLen
    from pydantic import create_model

    action = deepcopy(output_format.model_fields["action"])
    action.metadata.extend([MinLen(1), MaxLen(1)])
    action.description = "Exactly one next browser action; wait for its actual result before choosing another."
    return create_model(f"{output_format.__name__}SingleAction", __base__=output_format, action=(action.annotation, action))
