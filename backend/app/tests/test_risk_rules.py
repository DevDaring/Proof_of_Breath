"""Positive, negative and obfuscated examples per rule (spec section 7.1)."""
import json
from pathlib import Path

import pytest

from app.core.risk_rules import DEFAULT_RULES, classify, compile_rule, extract_target, normalise, rule_matches

POSITIVE = {
    "terraform-destroy": ["terraform destroy", "terraform  destroy -auto-approve", "cd infra && terraform destroy", "TERRAFORM DESTROY",
                          "terraform apply -destroy", "terraform apply -auto-approve -destroy", '"terraform" destroy', "terraform.exe destroy"],
    "sql-drop": ["DROP TABLE users", "drop   database prod", "psql -c 'DROP SCHEMA public CASCADE'", 'psql -c "drop table x"', "DROP\tTABLE t"],
    "sql-truncate": ["TRUNCATE users", "TRUNCATE TABLE users", "psql -c 'truncate table orders;'"],
    "sql-delete-no-where": ["DELETE FROM users", "delete from users;", "psql -c 'DELETE FROM orders'"],
    "git-force-protected": ["git push --force origin main", "git push -f origin master", "git push origin main --force",
                            "git  push  --force-with-lease  origin  main", "cd x && git push -f origin production", "git push --force origin HEAD:main",
                            "git -C repo push --force origin main"],
    "git-force-plus-refspec": ["git push origin +main", "git push origin +HEAD:master"],
    "git-force-implicit": ["git push --force", "git push -f", "git push --force origin", "git push -f && echo done", "git -C repo push -f"],
    "git-reset-hard": ["git reset --hard", "git reset --hard HEAD~3", "git reset --hard origin/main"],
    "rm-recursive-force": ["rm -rf /", "rm -rf ~/project", "rm -fr build", "rm -r -f data", "rm --recursive --force data", "rm  -rf  /etc",
                           '"rm" -rf /etc', "r\\m -rf /etc", "sudo rm -rf /var/lib/postgresql", "cd / && rm -rf home",
                           "rm -rf /tmp/../etc", "rm -rf /tmp/ok /etc"],
    "powershell-remove-item": ["Remove-Item -Recurse -Force C:\\Users\\me", "remove-item -r -fo C:\\data", "ri -r -fo C:\\data",
                               "Remove-Item C:\\data -Force -Recurse"],
    "cmd-recursive-delete": ["rd /s /q C:\\data", "rmdir /s C:\\data", "del /s /q C:\\data"],
    "kubectl-delete-namespace": ["kubectl delete namespace prod", "kubectl delete ns prod", "kubectl -n x delete ns/prod", "kubectl  delete   namespaces prod"],
    "docker-prune-volumes": ["docker system prune -a --volumes", "docker system prune --volumes -a", "docker system prune --all --volumes -f", "docker system prune -af --volumes"],
    "aws-delete": ["aws s3api delete-bucket --bucket x", "aws rds delete-db-instance --db-instance-identifier x", "aws s3 rb s3://x", "aws s3 rm s3://x --recursive"],
    "azure-delete": ["az group delete --name x", "az vm delete -n x -g y"],
    "gcloud-delete": ["gcloud compute instances delete x", "gcloud projects delete x"],
}

NEGATIVE = [
    "ls -la", "npm test", "git status", "git push origin main", "git push origin feature/x", "git push --force origin feature/x",
    "git push -f origin my-feature", "git reset --soft HEAD~1", "git reset HEAD file.txt", "terraform plan", "terraform apply",
    "SELECT * FROM users", "DELETE FROM users WHERE id = 1", "delete from t where x=1;", "rm file.txt", "rm -f file.txt", "rm -r dir",
    "rm -rf /tmp/build", "rm -rf /tmp", "rm -rf /var/tmp/cache", "rm -rf /tmp/a /tmp/b", "kubectl get namespaces", "kubectl delete pod x",
    "docker system prune", "docker system prune -a", "docker ps", "aws s3 ls", "aws ec2 describe-instances", "az vm list",
    "gcloud compute instances list", "truncate -s 0 file.log", "echo hello", "python drop_table_test.py", "cat terraform.tfstate",
    "Get-ChildItem -Recurse", "Remove-Item file.txt", "Remove-Item -Recurse -Force C:\\Temp\\build", "Remove-Item -Recurse -Force $env:TEMP\\x",
    "grep -rf patterns.txt src",
]


@pytest.mark.parametrize("key,command", [(k, c) for k, v in POSITIVE.items() for c in v])
def test_positive(key, command):
    rule = next(r for r in DEFAULT_RULES if r["key"] == key)
    assert rule_matches(compile_rule(rule["pattern"]), command), f"{key} should gate: {command}"


@pytest.mark.parametrize("command", NEGATIVE)
def test_negative(command):
    assert classify(command) is None, command


def test_every_rule_has_examples():
    assert {r["key"] for r in DEFAULT_RULES} == set(POSITIVE)


def test_catastrophic_pattern_fails_closed_quickly():
    assert rule_matches(compile_rule(r"(a+)+$"), "a" * 5000 + "!") is True


def test_invalid_patterns_are_reported():
    for bad in ("(", "", "   ", "a" * 501):
        with pytest.raises(ValueError):
            compile_rule(bad)


def test_disabled_rule_is_skipped():
    rules = [dict(r, enabled=False) for r in DEFAULT_RULES]
    assert classify("terraform destroy", rules) is None


def test_normalise():
    assert normalise('  "rm"   -rf  r\\oot ') == "rm -rf root"
    assert normalise("Remove-Item C:\\Temp\\x") == "remove-item c:\\temp\\x"


@pytest.mark.parametrize("command,target", [
    ("DROP TABLE users", "users"), ("DROP TABLE IF EXISTS app.users;", "app.users"), ("TRUNCATE TABLE orders", "orders"),
    ("DELETE FROM logs", "logs"), ("git push --force origin main", "main"), ("kubectl delete ns prod", "prod"),
    ("rm -rf /etc", "/etc"), ("terraform destroy", "terraform destroy"),
])
def test_extract_target(command, target):
    assert extract_target(command) == target


def test_interceptor_rule_copy_is_identical():
    copy = Path(__file__).parents[3] / "interceptors" / "common" / "default_rules.json"
    assert json.loads(copy.read_text()) == DEFAULT_RULES
