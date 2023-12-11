import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as cognito from "aws-cdk-lib/aws-cognito";
import * as agw from 'aws-cdk-lib/aws-apigatewayv2';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as iam from 'aws-cdk-lib/aws-iam';

import path = require("path");

export class HttpApiGatewayJwtCognitoStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // create Cognito UserPool
    const userPool = new cognito.UserPool(this, "UserPool", {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // create and add Application Integration for the User Pool
    // and add support for oAuth / JWT tokens
    const appIntegrationClient = userPool.addClient("WebClient", {
      userPoolClientName: "MyAppWebClient",
      idTokenValidity: cdk.Duration.days(1),
      accessTokenValidity: cdk.Duration.days(1),
      authFlows: {
        adminUserPassword: true
      },
      oAuth: {
        flows: {authorizationCodeGrant: true},
        scopes: [cognito.OAuthScope.OPENID]
      },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO]
    });

    // create a Lambda function for API Gateway to invoke
    const lambdaFn = new lambda.Function(this, "lambdaFn", {
      code: lambda.Code.fromAsset(path.join(__dirname, "../lambda")),
      runtime: lambda.Runtime.PYTHON_3_11,
      timeout: cdk.Duration.seconds(40),
      handler: "lambda_function.lambda_handler",
    });

    // create role to grant lambda invoke access to API Gateway
    const apiRole = new iam.Role(
      this, 'apiRole', {
        assumedBy: new iam.CompositePrincipal(
          new iam.ServicePrincipal('apigateway.amazonaws.com'),
          new iam.ServicePrincipal('lambda.amazonaws.com'),
        ),
        inlinePolicies: {
          bedrock: new iam.PolicyDocument({
            statements: [
              new iam.PolicyStatement({
                effect: iam.Effect.ALLOW,
                resources: [lambdaFn.functionArn],
                actions: [
                  "lambda:InvokeFunction",
                ],
              }),
            ],
          }),
        }
      });
    
    // define API Gateway HTTP API
    const httpAPI = new agw.CfnApi(this, 'httpAPI', {
      protocolType: 'HTTP',
      name: 'helloAPI',
      corsConfiguration: {
        maxAge: 123,
      }
    });

    // dynamically construct identity issuer (cognito) URL
    const issuer = `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`;

    // create JWT Authorizer for the HTTP API
    const jwtAuth = new agw.CfnAuthorizer(this, 'jwtAuth', {
      name: 'jwt-authorizer-hello-api',
      apiId: httpAPI.attrApiId,
      authorizerType: 'JWT',
      identitySource: ['$request.header.Authorization'],
      jwtConfiguration: {
        issuer: issuer,
        audience: [appIntegrationClient.userPoolClientId]
      }
    });

    // create integration with the Lambda function
    const apiInteg = new agw.CfnIntegration(this, 'apiInteg', {
      apiId: httpAPI.attrApiId,
      integrationType: 'AWS_PROXY',
      integrationUri: lambdaFn.functionArn,
      payloadFormatVersion: '1.0',
      credentialsArn: apiRole.roleArn

    });
    
    // create a route as a 'GET /hello' endpoint on the HTTP API
    const apiRoute = new agw.CfnRoute(this, 'helloRoute', {
      apiId: httpAPI.attrApiId,
      routeKey: 'GET /hello',
      target: `integrations/${apiInteg.ref}`,
      authorizationType: 'JWT',
      authorizerId: jwtAuth.ref
    });

    // add a deployment for the created HTTP API
    const apiDeployment = new agw.CfnDeployment(this, 'apiDeployment', {
      apiId: httpAPI.attrApiId,
    });
    // need to have the route configured before you can deploy the API
    apiDeployment.addDependency(apiRoute);

    // add a stage for the created HTTP API referencing the created API deployment
    const apiStage = new agw.CfnStage(this, 'apiStage', {
      apiId: httpAPI.attrApiId,
      stageName: 'api',
      deploymentId: apiDeployment.attrDeploymentId
    });

  }
}
