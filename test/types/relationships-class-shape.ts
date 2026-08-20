/**
 * search-relationships DecisionError must remain a class declaration:
 * constructible, instanceof-compatible, extensible, and usable as value+type.
 * Constructor typing matches v0.2.2 (inherited Error constructor; no details[] param).
 */
import { DecisionError, compileRelationships } from "@software-land/search/relationships";

class DerivedDecisionError extends DecisionError {}

const e = new DecisionError("bad decisions");
const derived = new DerivedDecisionError("derived");
const DecisionErrorConstructor = DecisionError;
const constructedFromAlias = new DecisionErrorConstructor("aliased");

const isDecisionError = e instanceof DecisionError;
const isError = e instanceof Error;
const isDerived = derived instanceof DecisionError;

const asType: DecisionError = e;
const message: string = asType.message;
const details: string[] | undefined = asType.details;

void compileRelationships;
void constructedFromAlias;
void isDecisionError;
void isError;
void isDerived;
void message;
void details;
void typeof DecisionError;
void new DerivedDecisionError("derived");
void new DecisionError();
