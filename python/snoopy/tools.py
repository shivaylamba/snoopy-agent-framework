"""Tool definitions, mirroring TS @snoopy/core defineTool."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable, Optional, Type

try:
    from pydantic import BaseModel
except ImportError:  # pragma: no cover
    BaseModel = None  # type: ignore[assignment, misc]


@dataclass
class ToolDef:
    name: str
    description: str
    input_model: Optional[Type[Any]] = None  # pydantic.BaseModel subclass
    handler: Callable[[Any], Any] = field(default=lambda x: x)
    idempotent: bool = True


def define_tool(
    *,
    name: str,
    description: str,
    input_model: Optional[Type[Any]] = None,
    idempotent: bool = True,
) -> Callable[[Callable[[Any], Any]], ToolDef]:
    """
    Decorator form:

        class WebSearchArgs(BaseModel):
            query: str
            k: int = 5

        @define_tool(name="web_search", description="...", input_model=WebSearchArgs)
        async def web_search(args: WebSearchArgs):
            return {"results": [...]}
    """
    def decorator(fn: Callable[[Any], Any]) -> ToolDef:
        return ToolDef(
            name=name,
            description=description,
            input_model=input_model,
            handler=fn,
            idempotent=idempotent,
        )

    return decorator
